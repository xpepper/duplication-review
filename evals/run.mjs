#!/usr/bin/env node
// Measures how often the Extract or Tolerate ruling flips across repeated
// headless runs of the skill. Runs claude -p against generated fixture repos
// and prints a summary table. Kept out of CI because each run costs tokens.

import { spawnSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FIXTURES, createFixtureRepo } from "./fixtures.mjs";
import { review } from "../scripts/clones.mjs";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_NAME = "duplication-review-eval";
const DEFAULT_RUNS = 5;
const DEFAULT_MODEL = "sonnet";

// Matches `### <name>: Extract` or `### <name>: Tolerate`, allowing optional
// inline emphasis or backticks around the ruling word.
const RULING_HEADING = /^###\s+.+?:\s*(?:\*\*|`)?(Extract|Tolerate)(?:\*\*|`)?\s*$/;

class Failure extends Error {}

/**
 * Extracts Extract or Tolerate rulings from markdown report headings, ignoring
 * anything inside fenced code blocks.
 */
export function parseRulings(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const rulings = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = RULING_HEADING.exec(line);
    if (match) rulings.push(match[1]);
  }
  return rulings;
}

function resolvedModel(payload) {
  if (payload?.modelUsage && typeof payload.modelUsage === "object") {
    const entries = Object.entries(payload.modelUsage);
    if (entries.length > 0) {
      let [bestModel, bestUsage] = entries[0];
      let bestTokens = Number.isFinite(bestUsage?.outputTokens) ? bestUsage.outputTokens : -1;
      for (const [model, usage] of entries.slice(1)) {
        const tokens = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : -1;
        if (tokens > bestTokens) {
          bestModel = model;
          bestTokens = tokens;
        }
      }
      return bestModel;
    }
  }
  return typeof payload?.model === "string" ? payload.model : null;
}

function firstLine(text, max = 120) {
  const line = String(text ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function formatDenial(denial) {
  const tool = denial?.tool_name ?? "unknown";
  const command = denial?.tool_input?.command;
  return command ? `${tool}(${command})` : tool;
}

const other = (reason, model = null) => ({ ruling: "other", model, reason });

/**
 * Classifies one headless claude invocation into Extract, Tolerate, or other
 * with a diagnostic reason on errors, permission denials, or unparsable output.
 */
export function classifyRun(outcome) {
  if (outcome.signal) return other(`claude terminated by ${outcome.signal}`);
  if (outcome.status !== 0) {
    const detail = firstLine(`${outcome.stderr ?? ""}${outcome.stdout ?? ""}`);
    return other(`claude exited with ${outcome.status}${detail ? `: ${detail}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(outcome.stdout);
  } catch {
    return other("invalid JSON from claude");
  }

  const model = resolvedModel(payload);
  if (payload?.is_error) {
    const message = firstLine(payload.result);
    return other(`claude reported an error${message ? `: ${message}` : ""}`, model);
  }

  const denials = Array.isArray(payload?.permission_denials) ? payload.permission_denials : [];
  if (denials.length > 0) {
    return other(`permission denied: ${denials.map(formatDenial).join(", ")}`, model);
  }

  const rulings = parseRulings(payload?.result ?? "");
  if (rulings.length === 0) {
    const snippet = firstLine(payload?.result);
    return other(`no parsable ruling heading${snippet ? ` (got: ${snippet})` : ""}`, model);
  }
  if (rulings.length > 1) {
    return other(`expected 1 ruling, found ${rulings.length} (${rulings.join(", ")})`, model);
  }
  return { ruling: rulings[0], model, reason: null };
}

/**
 * Tallies classified runs for one fixture into table counts and failure records.
 */
export function tallyRuns(fixture, outcomes) {
  const row = {
    fixture: fixture.name,
    expected: fixture.expected,
    Extract: 0,
    Tolerate: 0,
    other: 0,
    failures: [],
  };
  outcomes.forEach((outcome, index) => {
    row[outcome.ruling]++;
    if (outcome.ruling === "other") {
      row.failures.push({
        fixture: fixture.name,
        run: index + 1,
        reason: outcome.reason ?? "unparsable ruling",
      });
    }
  });
  return row;
}

/**
 * Formats summary rows as an aligned plain-text table with no trailing spaces.
 */
export function formatTable(rows) {
  const columns = ["fixture", "expected", "Extract", "Tolerate", "other"];
  const data = rows.map((row) => columns.map((col) => String(row[col])));
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...data.map((cells) => cells[i].length)),
  );
  const render = (cells) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
      .join("  ");
  return [render(columns), ...data.map(render)].join("\n");
}

const USAGE = `Usage: node evals/run.mjs [options]

Runs the skill headlessly against each stability fixture and prints a table of
Extract, Tolerate, and other counts. Exits 1 if any run produces no parsable
ruling.

Options:
  --runs <N>         Runs per fixture (default: ${DEFAULT_RUNS})
  --model <model>    Model passed to claude --model (default: ${DEFAULT_MODEL})
  --fixture <name>   Run only the named fixture (repeatable or comma-separated)
  --check-fixtures   Verify fixtures with scripts/clones.mjs without calling claude
  -h, --help         Show this help`;

/**
 * Parses CLI flags against the available fixture names.
 */
export function parseArgs(argv, fixtureNames) {
  const options = {
    runs: DEFAULT_RUNS,
    model: DEFAULT_MODEL,
    fixtures: [...fixtureNames],
    checkFixtures: false,
    help: false,
  };
  const selected = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--check-fixtures") {
      options.checkFixtures = true;
      continue;
    }
    if (arg === "--runs") {
      const raw = argv[++i];
      if (!raw || !/^[1-9]\d*$/.test(raw)) {
        throw new Failure(`--runs must be a positive integer (got '${raw ?? ""}').`);
      }
      options.runs = Number(raw);
      continue;
    }
    if (arg === "--model") {
      const value = argv[++i];
      if (!value) throw new Failure("Missing value for --model.");
      options.model = value;
      continue;
    }
    if (arg === "--fixture") {
      const value = argv[++i];
      const names = (value ?? "").split(",").filter(Boolean);
      if (names.length === 0) throw new Failure("Missing value for --fixture.");
      for (const name of names) {
        if (!fixtureNames.includes(name)) {
          throw new Failure(
            `Unknown fixture '${name}'. Available: ${fixtureNames.join(", ")}.`,
          );
        }
        if (!selected.includes(name)) selected.push(name);
      }
      continue;
    }
    throw new Failure(`Unknown or incomplete option '${arg}'.\n\n${USAGE}`);
  }
  if (selected.length > 0) options.fixtures = selected;
  return options;
}

function invokeClaude(cwd, { model, skillName }) {
  // Isolate from user-level skills and MCP servers so the run tests this repo's
  // SKILL.md cleanly, including its allowed-tools frontmatter, and leaves no
  // throwaway session behind.
  const run = spawnSync(
    "claude",
    [
      "-p", `/${skillName}`,
      "--model", model,
      "--output-format", "json",
      "--no-session-persistence",
      "--setting-sources", "project",
      "--strict-mcp-config",
    ],
    { cwd, encoding: "utf8" },
  );
  if (run.error) throw new Failure(`Could not run claude: ${run.error.message}`);
  return run;
}

/**
 * Runs each fixture `runs` times in a fresh throwaway git repo, returning the
 * tallied rows, resolved model IDs, and any unparsable-run failures.
 */
export function runEvals({
  fixtures,
  runs,
  model,
  skillDir = SKILL_DIR,
  skillName = SKILL_NAME,
  invoke = invokeClaude,
  onProgress = () => {},
}) {
  const rows = [];
  const failures = [];
  const models = new Set();

  for (const fixture of fixtures) {
    const outcomes = [];
    for (let run = 1; run <= runs; run++) {
      const dir = createFixtureRepo(fixture, { skillDir, skillName });
      const started = Date.now();
      let classified;
      try {
        classified = classifyRun(invoke(dir, { model, skillName }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (classified.model) models.add(classified.model);
      outcomes.push(classified);
      onProgress({
        fixture: fixture.name,
        run,
        runs,
        ruling: classified.ruling,
        reason: classified.reason,
        seconds: (Date.now() - started) / 1000,
      });
    }
    const row = tallyRuns(fixture, outcomes);
    rows.push(row);
    failures.push(...row.failures);
  }

  return { rows, failures, models: [...models] };
}

/**
 * Runs scripts/clones.mjs on one fixture repo and returns its counts, clone
 * kinds, and any mismatch against the fixture's expected single family, zero
 * bystanders, and clone kinds.
 */
export function checkFixture(
  fixture,
  { skillDir = SKILL_DIR, skillName = SKILL_NAME, scan = review } = {},
) {
  const dir = createFixtureRepo(fixture, { skillDir, skillName });
  let summary;
  try {
    summary = scan({ cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const families = summary.families.length;
  const bystanders = summary.bystanders.count;
  const clones = summary.families
    .flatMap((f) => f.clones)
    .map((c) => (c.method ? `${c.kind}/${c.method}` : c.kind));
  const problems = [];
  if (families !== 1) {
    problems.push(`expected 1 touched family, got ${families}`);
  }
  if (bystanders !== 0) {
    problems.push(`expected 0 bystanders, got ${bystanders}`);
  }
  const expectedClones = Array.isArray(fixture.expectedClones) ? fixture.expectedClones : [];
  const expected = [...expectedClones].sort();
  const actual = [...clones].sort();
  if (
    expected.length === 0 ||
    expected.length !== actual.length ||
    expected.some((kind, i) => kind !== actual[i])
  ) {
    problems.push(
      `expected clones [${expectedClones.join(", ")}], got [${clones.join(", ")}]`,
    );
  }
  return { families, bystanders, clones, problems };
}

function checkFixtures(fixtures) {
  let ok = true;
  for (const fixture of fixtures) {
    const { families, bystanders, clones, problems } = checkFixture(fixture);
    console.log(
      `${fixture.name} (${fixture.expected}): families=${families} bystanders=${bystanders} clones=[${clones.join(", ")}]`,
    );
    for (const problem of problems) {
      console.error(`  FAIL: ${problem}`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
}

function main(argv) {
  const options = parseArgs(argv, FIXTURES.map((f) => f.name));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const selected = FIXTURES.filter((f) => options.fixtures.includes(f.name));
  if (options.checkFixtures) {
    checkFixtures(selected);
    return;
  }

  const { rows, failures, models } = runEvals({
    fixtures: selected,
    runs: options.runs,
    model: options.model,
    onProgress: ({ fixture, run, runs, ruling, reason, seconds }) => {
      const detail = reason ? ` (${reason})` : "";
      console.error(`[${run}/${runs}] ${fixture}: ${ruling}${detail} [${seconds.toFixed(1)}s]`);
    },
  });

  const modelLabel = models.length > 0 ? models.join(", ") : options.model;
  console.log(`Model: ${modelLabel} (requested: ${options.model}) · Runs: ${options.runs}\n`);
  console.log(formatTable(rows));

  if (failures.length > 0) {
    console.error(`\nFailed: ${failures.length} run(s) produced no parsable ruling:`);
    for (const failure of failures) {
      console.error(`- ${failure.fixture} run ${failure.run}: ${failure.reason}`);
    }
    process.exit(1);
  }
}

// Node resolves symlinks in import.meta.url but not in process.argv[1], so
// compare real paths when invoked through a symlinked path.
function runAsScript() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (runAsScript()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
