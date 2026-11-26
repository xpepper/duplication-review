import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES, createFixtureRepo } from "../evals/fixtures.mjs";
import {
  checkFixture,
  classifyRun,
  formatTable,
  parseArgs,
  parseRulings,
  runEvals,
  tallyRuns,
} from "../evals/run.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseRulings extracts Extract and Tolerate headings", () => {
  const report = [
    "Whole tree: 1 clone, 12 duplicated lines, 50%.",
    "",
    "### priceItems: Extract",
    "Would have made this change easy because: both files share one rule.",
    "",
    "### cart setup: Tolerate",
    "Would have made this change easy because: differing step is the point.",
  ].join("\n");

  assert.deepEqual(parseRulings(report), ["Extract", "Tolerate"]);
});

test("parseRulings accepts backticks or bold markers on headings", () => {
  const report = [
    "### `priceItems`: **Extract**",
    "### **cart setup**: `Tolerate`",
  ].join("\n");

  assert.deepEqual(parseRulings(report), ["Extract", "Tolerate"]);
});

test("parseRulings ignores headings inside fenced code blocks and template lines", () => {
  const report = [
    "```markdown",
    "### <element name>: Extract",
    "```",
    "### <element name>: Extract | Tolerate",
    "### Bystanders",
    "### realElement: Tolerate",
  ].join("\n");

  assert.deepEqual(parseRulings(report), ["Tolerate"]);
});

test("parseRulings returns empty list when no heading matches", () => {
  assert.deepEqual(parseRulings(""), []);
  assert.deepEqual(parseRulings("No clones found."), []);
  assert.deepEqual(parseRulings("### foo: Refactor"), []);
});

const jsonOutcome = (payload, extra = {}) => ({
  status: 0,
  signal: null,
  stdout: JSON.stringify(payload),
  stderr: "",
  ...extra,
});

test("classifyRun reads a single Extract or Tolerate ruling and resolved model", () => {
  const extract = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "### priceItems: Extract\nReason.",
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 100 } },
    }),
  );
  assert.deepEqual(extract, {
    ruling: "Extract",
    model: "claude-sonnet-4-6",
    reason: null,
  });

  const tolerate = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "### cart setup: Tolerate\nReason.",
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 100 } },
    }),
  );
  assert.deepEqual(tolerate, {
    ruling: "Tolerate",
    model: "claude-sonnet-4-6",
    reason: null,
  });
});

test("classifyRun picks the modelUsage entry with the most outputTokens", () => {
  const withHelper = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "### priceItems: Extract\nReason.",
      modelUsage: {
        "claude-haiku-4-5": { inputTokens: 200, outputTokens: 12 },
        "claude-sonnet-5-5": { inputTokens: 800, outputTokens: 420 },
      },
    }),
  );
  assert.equal(withHelper.model, "claude-sonnet-5-5");

  const withoutTokens = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "### priceItems: Extract\nReason.",
      modelUsage: {
        "claude-sonnet-5-5": {},
        "claude-haiku-4-5": {},
      },
    }),
  );
  assert.equal(withoutTokens.model, "claude-sonnet-5-5");
});

test("classifyRun counts unparsable, multi-ruling, and failed runs as other", () => {
  const noHeading = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "Looks duplicated, maybe extract it.",
      modelUsage: { "claude-sonnet-4-6": {} },
    }),
  );
  assert.equal(noHeading.ruling, "other");
  assert.match(noHeading.reason, /no parsable ruling.*Looks duplicated/i);
  assert.equal(noHeading.model, "claude-sonnet-4-6");

  const denied = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "The command needs your approval to run.",
      permission_denials: [
        {
          tool_name: "Bash",
          tool_input: { command: "node .claude/skills/duplication-review-eval/scripts/clones.mjs" },
        },
      ],
      modelUsage: { "claude-sonnet-4-6": {} },
    }),
  );
  assert.equal(denied.ruling, "other");
  assert.match(denied.reason, /permission denied: Bash\(node \.claude\/skills\//);
  assert.equal(denied.model, "claude-sonnet-4-6");

  const multi = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "### a: Extract\n### b: Tolerate",
    }),
  );
  assert.equal(multi.ruling, "other");
  assert.match(multi.reason, /expected 1 ruling, found 2/i);

  const apiError = classifyRun(
    jsonOutcome({
      is_error: true,
      result: "authentication failed",
    }),
  );
  assert.equal(apiError.ruling, "other");
  assert.match(apiError.reason, /claude reported an error/i);

  const badJson = classifyRun({
    status: 0,
    signal: null,
    stdout: "not json",
    stderr: "",
  });
  assert.equal(badJson.ruling, "other");
  assert.match(badJson.reason, /invalid json/i);

  const nonZero = classifyRun({
    status: 1,
    signal: null,
    stdout: "",
    stderr: "command failed",
  });
  assert.equal(nonZero.ruling, "other");
  assert.match(nonZero.reason, /exited with 1/i);
});

test("classifyRun counts permission denials as other even when a ruling heading is present", () => {
  const recovered = classifyRun(
    jsonOutcome({
      is_error: false,
      result: "### priceItems: Extract\nRecovered after retrying with the absolute path.",
      permission_denials: [
        {
          tool_name: "Bash",
          tool_input: { command: "node .claude/skills/duplication-review-eval/scripts/clones.mjs" },
        },
      ],
      modelUsage: { "claude-sonnet-5-5": { outputTokens: 150 } },
    }),
  );

  assert.equal(recovered.ruling, "other");
  assert.match(recovered.reason, /permission denied: Bash\(node \.claude\/skills\//);
  assert.equal(recovered.model, "claude-sonnet-5-5");
});

test("tallyRuns counts Extract, Tolerate, and other and collects failures", () => {
  const row = tallyRuns({ name: "look-alike-test", expected: "Tolerate" }, [
    { ruling: "Tolerate", model: "claude-sonnet-4-6", reason: null },
    { ruling: "Extract", model: "claude-sonnet-4-6", reason: null },
    { ruling: "other", model: "claude-sonnet-4-6", reason: "no parsable ruling heading" },
  ]);

  assert.deepEqual(row, {
    fixture: "look-alike-test",
    expected: "Tolerate",
    Extract: 1,
    Tolerate: 1,
    other: 1,
    failures: [{ fixture: "look-alike-test", run: 3, reason: "no parsable ruling heading" }],
  });
});

test("formatTable aligns columns cleanly with no trailing spaces", () => {
  const table = formatTable([
    { fixture: "copied-rule", expected: "Extract", Extract: 5, Tolerate: 0, other: 0 },
    { fixture: "look-alike-test", expected: "Tolerate", Extract: 1, Tolerate: 4, other: 0 },
  ]);

  assert.equal(
    table,
    [
      "fixture          expected  Extract  Tolerate  other",
      "copied-rule      Extract   5        0         0",
      "look-alike-test  Tolerate  1        4         0",
    ].join("\n"),
  );
});

test("parseArgs applies defaults and parses --runs, --model, --fixture, --check-fixtures", () => {
  const names = ["copied-rule", "look-alike-test"];
  assert.deepEqual(parseArgs([], names), {
    runs: 5,
    model: "sonnet",
    fixtures: names,
    checkFixtures: false,
    help: false,
  });

  assert.deepEqual(
    parseArgs(["--runs", "3", "--model", "opus", "--fixture", "look-alike-test"], names),
    {
      runs: 3,
      model: "opus",
      fixtures: ["look-alike-test"],
      checkFixtures: false,
      help: false,
    },
  );

  assert.deepEqual(parseArgs(["--fixture", "copied-rule,look-alike-test"], names).fixtures, names);
  assert.equal(parseArgs(["--check-fixtures"], names).checkFixtures, true);
  assert.equal(parseArgs(["--help"], names).help, true);
});

test("parseArgs rejects invalid --runs, unknown fixtures, and unknown flags", () => {
  const names = ["copied-rule"];
  assert.throws(() => parseArgs(["--runs", "0"], names), /positive integer/);
  assert.throws(() => parseArgs(["--runs", "1.5"], names), /positive integer/);
  assert.throws(() => parseArgs(["--runs", "abc"], names), /positive integer/);
  assert.throws(() => parseArgs(["--runs"], names), /positive integer|incomplete/);
  assert.throws(() => parseArgs(["--fixture", ","], names), /Missing value for --fixture/);
  assert.throws(() => parseArgs(["--fixture", "missing"], names), /Unknown fixture 'missing'/);
  assert.throws(() => parseArgs(["--bogus"], names), /Unknown or incomplete option/);
});

test("createFixtureRepo links only SKILL.md and scripts/ and hides the fixture name", (t) => {
  const fixture = FIXTURES[0];
  const dir = createFixtureRepo(fixture, { skillDir: REPO_ROOT });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(dir.includes(fixture.name), false);

  const subjects = execFileSync("git", ["log", "--format=%s"], {
    cwd: dir,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.deepEqual(subjects, ["change", "base"]);

  const skillTarget = join(dir, ".claude", "skills", "duplication-review-eval");
  assert.equal(lstatSync(skillTarget).isDirectory(), true);
  assert.equal(lstatSync(join(skillTarget, "SKILL.md")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(skillTarget, "scripts")).isSymbolicLink(), true);
  assert.equal(existsSync(join(skillTarget, "SKILL.md")), true);
  assert.equal(existsSync(join(skillTarget, "scripts", "clones.mjs")), true);
  assert.equal(existsSync(join(skillTarget, "evals")), false);

  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.claude$/m);

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  assert.equal(status, "");
});

test("createFixtureRepo creates .git/info when git template omits it and cleans up on error", (t) => {
  const emptyTemplate = mkdtempSync(join(tmpdir(), "eval-empty-template-"));
  const isolatedTmp = mkdtempSync(join(tmpdir(), "eval-isolated-tmp-"));
  t.after(() => {
    rmSync(emptyTemplate, { recursive: true, force: true });
    rmSync(isolatedTmp, { recursive: true, force: true });
  });

  const prevTemplate = process.env.GIT_TEMPLATE_DIR;
  process.env.GIT_TEMPLATE_DIR = emptyTemplate;
  let dir;
  try {
    dir = createFixtureRepo(FIXTURES[0], { skillDir: REPO_ROOT });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\.claude$/m);
  } finally {
    if (prevTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = prevTemplate;
  }

  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  try {
    assert.throws(() =>
      createFixtureRepo({ name: "broken", baseFiles: { ".": "invalid" }, changeFiles: {} }),
    );
    assert.deepEqual(readdirSync(isolatedTmp), []);
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  }
});

test("runEvals counts unparsable runs under other, reports failures, and removes temp repos", () => {
  const seenDirs = [];
  let call = 0;
  const invoke = (cwd) => {
    seenDirs.push(cwd);
    call++;
    if (call === 2) {
      return jsonOutcome({
        is_error: false,
        result: "I forgot to include a ruling heading.",
        modelUsage: { "claude-sonnet-4-6": {} },
      });
    }
    return jsonOutcome({
      is_error: false,
      result: "### priceItems: Extract\nShared business rule.",
      modelUsage: { "claude-sonnet-4-6": {} },
    });
  };

  const result = runEvals({
    fixtures: [FIXTURES[0]],
    runs: 2,
    model: "sonnet",
    skillDir: REPO_ROOT,
    invoke,
    onProgress: () => {},
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].Extract, 1);
  assert.equal(result.rows[0].Tolerate, 0);
  assert.equal(result.rows[0].other, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].run, 2);
  assert.deepEqual(result.models, ["claude-sonnet-4-6"]);
  assert.equal(seenDirs.length, 2);
  assert.notEqual(seenDirs[0], seenDirs[1]);
  assert.equal(existsSync(seenDirs[0]), false);
  assert.equal(existsSync(seenDirs[1]), false);
});

test("CLI prints the table, counts unparsable output under other, and exits 1", (t) => {
  const binDir = mkdtempSync(join(tmpdir(), "eval-fake-claude-"));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const fakeClaude = join(binDir, "claude");
  const argsLog = join(binDir, "args.txt");
  writeFileSync(
    fakeClaude,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${argsLog}"`,
      'printf \'{"is_error":false,"result":"No heading here.","modelUsage":{"fake-sonnet":{}}}\\n\'',
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);

  const script = join(REPO_ROOT, "evals", "run.mjs");
  const res = spawnSync(
    "node",
    [script, "--runs", "1", "--model", "sonnet", "--fixture", "copied-rule"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    },
  );

  assert.equal(res.status, 1);
  assert.match(res.stdout, /Model: fake-sonnet \(requested: sonnet\) · Runs: 1/);
  assert.match(res.stdout, /copied-rule\s+Extract\s+0\s+0\s+1/);
  assert.match(res.stderr, /Failed: 1 run\(s\) produced no parsable ruling/);
  assert.match(res.stderr, /copied-rule run 1: no parsable ruling heading \(got: No heading here\.\)/);

  const argv = readFileSync(argsLog, "utf8").trimEnd().split("\n");
  assert.ok(argv.includes("--setting-sources"));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--no-session-persistence"));
  assert.equal(argv.includes("--allowedTools"), false);
  assert.equal(
    argv.some((arg) => arg.startsWith("Bash(")),
    false,
  );
  assert.equal(argv.includes("Read"), false);
});

test("checkFixture reports family count, bystander, and clone-kind mismatches", () => {
  const fixture = {
    ...FIXTURES[0],
    expectedClones: ["similar/gap", "renamed"],
  };

  const matching = checkFixture(fixture, {
    skillDir: REPO_ROOT,
    scan: () => ({
      families: [{ clones: [{ kind: "renamed" }, { kind: "similar", method: "gap" }] }],
      bystanders: { count: 0 },
    }),
  });
  assert.deepEqual(matching.problems, []);

  const mismatched = checkFixture(fixture, {
    skillDir: REPO_ROOT,
    scan: () => ({
      families: [{ clones: [{ kind: "exact" }] }, { clones: [] }],
      bystanders: { count: 2 },
    }),
  });
  assert.equal(mismatched.problems.length, 3);
  assert.match(mismatched.problems[0], /expected 1 touched family, got 2/);
  assert.match(mismatched.problems[1], /expected 0 bystanders, got 2/);
  assert.match(
    mismatched.problems[2],
    /expected clones \[similar\/gap, renamed\], got \[exact\]/,
  );
});

test("every fixture produces one touched family, zero bystanders, and its expected clone kinds", () => {
  for (const fixture of FIXTURES) {
    assert.ok(
      fixture.expected === "Extract" || fixture.expected === "Tolerate",
      `${fixture.name} expected ruling must be Extract or Tolerate`,
    );
    const { problems } = checkFixture(fixture, { skillDir: REPO_ROOT });
    assert.deepEqual(problems, [], `${fixture.name}: ${problems.join("; ")}`);
  }
});
