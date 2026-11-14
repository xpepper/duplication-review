// End-to-end: runs the script against a throwaway git repository with known
// clones. Needs network the first time, because the script fetches jscpd.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function run(...args) {
  const result = spawnSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
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
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("a branch with nothing changed reports nothing and scans nothing", () => {
  const { status, summary } = run();

  assert.equal(status, 0);
  assert.deepEqual(summary, {
    base,
    changedFiles: 0,
    formats: [],
    report: null,
    totals: { clones: 0, duplicatedLines: 0, percentage: 0 },
    involved: [],
    bystanders: { count: 0, largest: [] },
  });
});

test("a committed copy is involved and an old clone elsewhere is a bystander", () => {
  write("src/order.js", totalFunction("orderTotal"));
  git("add", "--all");
  git("commit", "--quiet", "--message", "add order total");

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.equal(summary.base, base);
  assert.deepEqual(summary.formats, ["javascript"]);
  assert.deepEqual(
    summary.involved.map((clone) => clone.sides.map((side) => [side.path, side.touched]).sort()),
    [[["src/invoice.js", false], ["src/order.js", true]]],
  );
  assert.equal(summary.involved[0].isNew, true);
  assert.deepEqual(
    summary.bystanders.largest.map((clone) => clone.sides.map((side) => side.path).sort()),
    [["legacy/export_a.js", "legacy/export_b.js"]],
  );
  assert.equal(summary.bystanders.largest[0].isNew, false);
  assert.equal(summary.involved.length + summary.bystanders.count, summary.totals.clones);
});

test("only the languages of the changed files are scanned", () => {
  const { summary } = run();
  const formats = [...summary.involved, ...summary.bystanders.largest].map((clone) => clone.format);

  assert.deepEqual([...new Set(formats)], ["javascript"]);
  assert.equal(summary.totals.clones, 2, "the Python clone is not counted");
});

test("the report lands in the git directory and the working tree stays clean", () => {
  const { summary } = run();

  assert.equal(summary.report, join(repo, ".git", "jscpd-out", "jscpd-report.json"));
  assert.ok(existsSync(summary.report));
  assert.equal(git("status", "--short"), "");
});

test("a report left by an earlier run is cleared first", () => {
  const stale = join(repo, ".git", "jscpd-out", "stale.json");
  write(".git/jscpd-out/stale.json", "{}");

  run();

  assert.equal(existsSync(stale), false);
});

test("a repo's own .jscpd.json thresholds apply instead of the defaults", (t) => {
  t.after(() => rmSync(join(repo, ".jscpd.json")));
  write(".jscpd.json", JSON.stringify({ minLines: 50 }));

  const { summary } = run();

  assert.equal(summary.totals.clones, 0);
});

test("uncommitted and untracked files count as part of the change", (t) => {
  t.after(() => {
    git("checkout", "--", "legacy/export_a.js");
    rmSync(join(repo, "src/cart.js"), { force: true });
  });
  write("legacy/export_a.js", reportFunction("exportA").replace("lines.sort();", "lines.reverse();"));
  write("src/cart.js", totalFunction("cartTotal"));

  const { summary } = run();
  const touched = summary.involved.flatMap((clone) =>
    clone.sides.filter((side) => side.touched).map((side) => side.path),
  );

  assert.ok(touched.includes("src/cart.js"), "untracked file");
  assert.ok(touched.includes("legacy/export_a.js"), "uncommitted edit");
  assert.equal(summary.bystanders.count, 0);
  assert.equal(summary.involved.length, summary.totals.clones);
});

test("an explicit base narrows the change to what came after it", () => {
  const { summary } = run("--base", "HEAD");

  assert.equal(summary.base, git("rev-parse", "HEAD"));
  assert.equal(summary.changedFiles, 0);
});

test("it runs when the skill directory is reached through a symlink", (t) => {
  const links = mkdtempSync(join(tmpdir(), "clones-link-"));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  symlinkSync(join(dirname(SCRIPT), ".."), join(links, "skill"));

  const linked = join(links, "skill", "scripts", "clones.mjs");
  const result = spawnSync("node", [linked, "--base", "HEAD"], { cwd: repo, encoding: "utf8" });

  assert.equal(JSON.parse(result.stdout || "null")?.changedFiles, 0);
});

test("a base that does not exist fails with a message instead of a stack trace", () => {
  const { status, stderr } = run("--base", "no-such-branch");

  assert.equal(status, 1);
  assert.equal(stderr.trim(), "No merge base between HEAD and 'no-such-branch'.");
});

test("outside a git repository it says so", () => {
  const result = spawnSync("node", [SCRIPT], { cwd: tmpdir(), encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Not inside a git repository.");
});
