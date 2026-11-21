// End-to-end: runs the script against a throwaway git repository with known
// clones. Needs network the first time, because the script fetches jscpd.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSCPD_VERSION } from "../scripts/clones.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clones.mjs");

const totalFunction = (name) => `export function ${name}(items, taxRate) {
  let subtotal = 0;
  for (const item of items) {
    if (item.quantity <= 0) {
      throw new Error("invalid quantity for " + item.name);
    }
    subtotal += item.price * item.quantity;
  }
  const tax = subtotal * taxRate;
  const shipping = subtotal > 100 ? 0 : 9.99;
  return { subtotal, tax, shipping, total: subtotal + tax + shipping };
}
`;

const reportFunction = (name) => `export function ${name}(rows) {
  const lines = [];
  for (const row of rows) {
    if (!row.visible) {
      continue;
    }
    lines.push([row.id, row.label, row.amount.toFixed(2)].join(";"));
  }
  lines.sort();
  return ["id;label;amount", ...lines].join("\\n");
}
`;

const pythonFunction = (name) => `def ${name}(records, limit):
    kept = []
    for record in records:
        if record["size"] > limit:
            continue
        kept.append((record["id"], record["name"], record["size"]))
    kept.sort(key=lambda entry: entry[2])
    return [entry[0] for entry in kept if entry[1] is not None]
`;

let repo;
let base;

function git(...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: repo, encoding: "utf8" },
  ).trim();
}

function write(path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const clonesIn = (families) => families.reduce((sum, family) => sum + family.clones.length, 0);

function run(args = [], { cwd = repo, script = SCRIPT } = {}) {
  const result = spawnSync("node", [script, ...args], { cwd, encoding: "utf8" });
  return { ...result, summary: result.status === 0 ? JSON.parse(result.stdout) : null };
}

before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "clones-fixture-")));
  git("init", "--quiet", "--initial-branch", "main");
  write("src/invoice.js", totalFunction("invoiceTotal"));
  write("legacy/export_a.js", reportFunction("exportA"));
  write("legacy/export_b.js", reportFunction("exportB"));
  write("tools/sync_a.py", pythonFunction("sync_a"));
  write("tools/sync_b.py", pythonFunction("sync_b"));
  git("add", "--all");
  git("commit", "--quiet", "--message", "base");
  base = git("rev-parse", "HEAD");
  git("switch", "--quiet", "--create", "change");
  write("src/order.js", totalFunction("orderTotal"));
  git("add", "--all");
  git("commit", "--quiet", "--message", "add order total");
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("a branch with nothing changed reports nothing and scans nothing", (t) => {
  t.after(() => git("switch", "--quiet", "change"));
  git("switch", "--quiet", "main");

  const { status, summary } = run();

  assert.equal(status, 0);
  assert.deepEqual(summary, {
    jscpd: summary.jscpd,
    base,
    changedFiles: 0,
    formats: [],
    report: null,
    totals: { clones: 0, duplicatedLines: 0, percentage: 0 },
    families: [],
    bystanders: { count: 0, clones: 0, largest: [] },
  });
});

test("the summary names the exact jscpd version it ran", () => {
  const { status, summary } = run();

  assert.equal(status, 0);
  assert.match(summary.jscpd, /^\d+\.\d+\.\d+$/);
});

test("a committed copy is involved and an old clone elsewhere is a bystander", () => {
  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.equal(summary.base, base);
  assert.deepEqual(summary.formats, ["javascript"]);
  assert.deepEqual(
    summary.families.map((family) => family.fragments.map((f) => [f.path, f.touched])),
    [[["src/invoice.js", false], ["src/order.js", true]]],
  );
  assert.equal(summary.families[0].clones[0].origin, "introduced");
  assert.deepEqual(
    summary.bystanders.largest.map((family) => family.fragments.map((f) => f.path)),
    [["legacy/export_a.js", "legacy/export_b.js"]],
  );
  assert.equal(summary.bystanders.largest[0].clones[0].origin, "pre-existing");
  assert.equal(clonesIn(summary.families) + summary.bystanders.clones, summary.totals.clones);
});

test("only the languages of the changed files are scanned", () => {
  const { summary } = run();
  const formats = [...summary.families, ...summary.bystanders.largest]
    .flatMap((family) => family.clones)
    .map((clone) => clone.format);

  assert.deepEqual([...new Set(formats)], ["javascript"]);
  assert.equal(summary.totals.clones, 2, "the Python clone is not counted");
});

test("the report lands in the git directory and the working tree stays clean", () => {
  const { summary } = run();

  assert.equal(summary.report, join(repo, ".git", "jscpd-out", "jscpd-report.json"));
  assert.ok(existsSync(summary.report));
  assert.equal(git("status", "--short"), "");
});

// The branch adds a clone that the base lacks, so a scan against a baseline
// would count it as new. Origin comes from the diff, so no such scan is needed.
test("the scan compares against no baseline", () => {
  const { summary } = run();

  const report = JSON.parse(readFileSync(summary.report, "utf8"));
  assert.equal(report.statistics.total.newClones, 0);
});

test("a report left by an earlier run is cleared first", () => {
  const stale = join(repo, ".git", "jscpd-out", "stale.json");
  write(".git/jscpd-out/stale.json", "{}");

  run();

  assert.equal(existsSync(stale), false);
});

test("a repo's own .jscpd.json thresholds apply instead of the defaults", (t) => {
  t.after(() => rmSync(join(repo, ".jscpd.json"), { force: true }));
  write(".jscpd.json", JSON.stringify({ minLines: 50 }));

  const { summary } = run();

  assert.equal(summary.totals.clones, 0);
});

test("thresholds from a jscpd key in package.json apply instead of the defaults", (t) => {
  t.after(() => rmSync(join(repo, "package.json"), { force: true }));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));

  const { summary } = run();

  assert.equal(summary.totals.clones, 0);
});

// The script relies on jscpd's own minimum clone size. If a version bump
// changes it, decide whether to pass the old values again.
test(`jscpd ${JSCPD_VERSION} defaults to clones of at least 5 lines and 50 tokens`, () => {
  const empty = mkdtempSync(join(tmpdir(), "jscpd-defaults-"));
  try {
    const output = execFileSync("npx", ["--yes", `jscpd@${JSCPD_VERSION}`, ".", "--debug"], {
      cwd: empty,
      encoding: "utf8",
    });

    assert.match(output, /"min_lines": 5,/);
    assert.match(output, /"min_tokens": 50,/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("exit-code gates in .jscpd.json do not fail the scan", (t) => {
  t.after(() => rmSync(join(repo, ".jscpd.json"), { force: true }));
  write(
    ".jscpd.json",
    JSON.stringify({
      baseline: ".jscpd-baseline.json",
      baselineFromRef: "no-such-ref",
      threshold: 0,
      exitCode: 2,
      failOnNewClones: 0,
      failOnEmpty: true,
    }),
  );

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.ok(summary.families.length >= 1);

  write(".jscpd.json", JSON.stringify({ minLines: 50, failOnEmpty: true }));
  const empty = run();

  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.summary.totals.clones, 0);
});

// jscpd 5 also reads these kebab-case spellings from its config.
test("kebab-case gates in .jscpd.json do not fail the scan", (t) => {
  t.after(() => rmSync(join(repo, ".jscpd.json"), { force: true }));
  write(
    ".jscpd.json",
    JSON.stringify({ "baseline-from-ref": "no-such-ref", "exit-code": 2, "fail-on-new-clones": 0 }),
  );

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.ok(summary.families.length >= 1);
});

// jscpd 5.4.3 calls fail-on-empty an unknown field but still applies it, and
// a change that touches only files jscpd does not analyze scans no files.
test("kebab-case fail-on-empty in .jscpd.json does not fail a scan of no files", (t) => {
  t.after(() => {
    rmSync(join(repo, ".jscpd.json"), { force: true });
    rmSync(join(repo, "data.xyz"), { force: true });
    rmSync(join(repo, ".git", "info", "exclude"), { force: true });
    git("switch", "--quiet", "change");
  });
  git("switch", "--quiet", "main");
  // Keep the config out of the diff, so that data.xyz is the only change.
  write(".git/info/exclude", ".jscpd.json\n");
  write(".jscpd.json", JSON.stringify({ "fail-on-empty": true }));
  write("data.xyz", "not source code\n");

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.deepEqual(summary.formats, []);
});

test("exit-code gates under package.json's jscpd key do not fail the scan", (t) => {
  t.after(() => rmSync(join(repo, "package.json"), { force: true }));
  write(
    "package.json",
    JSON.stringify({ name: "fixture", jscpd: { threshold: 0, exitCode: 2, failOnNewClones: 0 } }),
  );

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.ok(summary.families.length >= 1);
});

test("a .jscpd.json takes precedence over package.json's jscpd key, as in jscpd itself", (t) => {
  t.after(() => {
    rmSync(join(repo, ".jscpd.json"), { force: true });
    rmSync(join(repo, "package.json"), { force: true });
  });
  write(".jscpd.json", JSON.stringify({}));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));

  const { summary } = run();

  assert.ok(summary.totals.clones > 0, "package.json's minLines is ignored");
});

test("a package.json that is not valid JSON is left to jscpd, which ignores it", (t) => {
  t.after(() => rmSync(join(repo, "package.json"), { force: true }));
  write("package.json", "{not valid json");

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.ok(summary.totals.clones > 0);
});

test("a .jscpd.json that is not valid JSON fails with a message", (t) => {
  t.after(() => rmSync(join(repo, ".jscpd.json"), { force: true }));
  write(".jscpd.json", "{not valid json");

  const { status, stderr } = run();

  assert.equal(status, 1);
  assert.match(stderr, /Invalid \.jscpd\.json:/);
});

test("uncommitted and untracked files count as part of the change", (t) => {
  t.after(() => {
    git("checkout", "--", "legacy/export_a.js");
    rmSync(join(repo, "src/cart.js"), { force: true });
  });
  write("legacy/export_a.js", reportFunction("exportA").replace("lines.sort();", "lines.reverse();"));
  write("src/cart.js", totalFunction("cartTotal"));

  const { summary } = run();
  const touched = summary.families.flatMap((family) =>
    family.fragments.filter((f) => f.touched).map((f) => f.path),
  );

  assert.ok(touched.includes("src/cart.js"), "untracked file");
  assert.ok(touched.includes("legacy/export_a.js"), "uncommitted edit");
  assert.deepEqual(summary.bystanders, { count: 0, clones: 0, largest: [] });
  assert.equal(clonesIn(summary.families), summary.totals.clones);
  assert.deepEqual(
    summary.families.map((family) => family.fragments.map((f) => f.path)),
    [["src/cart.js", "src/invoice.js", "src/order.js"], ["legacy/export_a.js", "legacy/export_b.js"]],
    "three copies of one function are one family",
  );
  // jscpd reports the edited copy as an exact prefix and a structural match; both predate the change.
  assert.deepEqual(
    summary.families.map((family) => [...new Set(family.clones.map((clone) => clone.origin))]),
    [["introduced"], ["pre-existing-edited"]],
  );
});

test("an explicit base narrows the change to what came after it", () => {
  const { summary } = run(["--base", "HEAD"]);

  assert.equal(summary.base, git("rev-parse", "HEAD"));
  assert.equal(summary.changedFiles, 0);
});

test("the base is the merge base, so commits made on the base branch since are not part of the change", (t) => {
  t.after(() => git("branch", "--force", "main", base));
  git("switch", "--quiet", "main");
  write("src/later.js", "export const later = 1;\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "later work on main");
  git("switch", "--quiet", "change");

  const { status, stderr, summary } = run(["--base", "main"]);

  assert.equal(status, 0, stderr);
  assert.equal(summary.base, base);
  assert.equal(summary.changedFiles, 1, "only src/order.js");
});

test("it runs when the skill directory is reached through a symlink", (t) => {
  const links = mkdtempSync(join(tmpdir(), "clones-link-"));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  symlinkSync(join(dirname(SCRIPT), ".."), join(links, "skill"));

  const linked = join(links, "skill", "scripts", "clones.mjs");
  const { status, summary } = run(["--base", "HEAD"], { script: linked });

  assert.equal(status, 0);
  assert.equal(summary.changedFiles, 0);
});

test("a base that does not exist fails with a message instead of a stack trace", () => {
  const { status, stderr } = run(["--base", "no-such-branch"]);

  assert.equal(status, 1);
  assert.equal(stderr.trim(), "No merge base between HEAD and 'no-such-branch'.");
});

test("outside a git repository it says so", () => {
  const { status, stderr } = run([], { cwd: tmpdir() });

  assert.equal(status, 1);
  assert.equal(stderr.trim(), "Not inside a git repository.");
});
