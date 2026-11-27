// End-to-end: runs the script against a throwaway git repository with known
// clones. Needs network the first time, because the script fetches jscpd.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// totalFunction with every local name changed: jscpd matches it by syntax tree.
const renamedTotalFunction = `export function quoteSum(lines, vat) {
  let net = 0;
  for (const line of lines) {
    if (line.count <= 0) {
      throw new Error("invalid quantity for " + line.label);
    }
    net += line.cost * line.count;
  }
  const levy = net * vat;
  const postage = net > 100 ? 0 : 9.99;
  return { net, levy, postage, total: net + levy + postage };
}
`;

// With `extra`, one line is inserted mid-block: jscpd merges the token clones around it.
const setupFunction = (name, extra) => `export function ${name}(config) {
  const server = createServer(config.port);
  server.use(logger("combined"));
  server.use(bodyParser.json());
  server.use(cors({ origin: config.origin }));
  server.use(rateLimit({ windowMs: 60000, max: 100 }));
${extra ? `  ${extra}\n` : ""}  server.use(helmet());
  server.use(compression());
  server.use(session({ secret: config.secret }));
  server.use(passport.initialize());
  server.use(passport.session());
  return server;
}
`;

// A test whose setup builds a cart, with the item prices as given.
const cartTest = (prices = [2.5, 12, 30]) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("a cart under the free shipping limit pays shipping", () => {
  const items = [
    { name: "pen", price: ${prices[0]}, quantity: 4 },
    { name: "book", price: ${prices[1]}, quantity: 1 },
    { name: "bag", price: ${prices[2]}, quantity: 2 },
  ];
  const taxRate = 0.2;
  const result = cartTotal(items, taxRate);
  assert.equal(result.subtotal, 82);
  assert.equal(result.tax, 16.4);
  assert.equal(result.shipping, 9.99);
  assert.equal(result.total, 108.39);
});
`;

// cartTest with every name changed. jscpd leaves test files out of its
// syntax-tree matching, so only a scan with names normalized finds this copy.
const basketTest = `import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteSum } from "../src/basket.js";

test("a basket under the free postage limit pays postage", () => {
  const lines = [
    { label: "pen", cost: 2.5, count: 4 },
    { label: "book", cost: 12, count: 1 },
    { label: "bag", cost: 30, count: 2 },
  ];
  const vat = 0.2;
  const quote = quoteSum(lines, vat);
  assert.equal(quote.net, 82);
  assert.equal(quote.levy, 16.4);
  assert.equal(quote.postage, 9.99);
  assert.equal(quote.total, 108.39);
});
`;

// Top-level code that sets up a server and then its routes, under the given
// names. `between` separates the two blocks with lines that differ.
const serverModule = (app, settings, between) => `const ${app} = createApp(${settings}.port);
${app}.use(logger("combined"));
${app}.use(bodyParser.json());
${app}.use(cors({ origin: ${settings}.origin }));
${app}.use(rateLimit({ windowMs: 60000, max: 100 }));
${app}.use(helmet());
${app}.use(compression());
${app}.use(session({ secret: ${settings}.secret }));
${app}.use(passport.initialize());
${app}.use(passport.session());
${between}
${app}.get("/health", (req, res) => res.send("ok"));
${app}.get("/version", (req, res) => res.send(${settings}.version));
${app}.post("/orders", (req, res) => res.status(201).send(createOrder(req.body)));
${app}.delete("/orders/:id", (req, res) => res.send(cancelOrder(req.params.id)));
${app}.listen(${settings}.port);
export default ${app};
`;

const SERVER_FIXTURE = {
  "src/server_a.js": serverModule("app", "settings", "logStartup(settings);\nconst startedAt = Date.now();"),
  "src/server_b.js": serverModule("api", "options", 'if (options.verbose) printBanner();\ntrackBoot("api", 2);'),
};

// Two setup functions that differ by one inserted line: one gap clone.
const GAP_FIXTURE = {
  "src/setup_a.js": setupFunction("setupA"),
  "src/setup_b.js": setupFunction("setupB", "server.use(metrics(config.metricsPath));"),
};

// A TypeScript class, with a decorator on its first method when one is given.
const priceController = (decorator) => `export class PriceController {
  constructor(private readonly repository: PriceRepository, private readonly clock: Clock) {}
${decorator ? `  ${decorator}\n` : ""}  current(sku: string): number {
    const entry = this.repository.find(sku);
    if (!entry) {
      throw new Error("unknown sku " + sku);
    }
    const now = this.clock.now();
    const active = entry.prices.filter((p) => p.from <= now && now < p.until);
    return active.length > 0 ? active[0].amount : entry.fallback;
  }
  history(sku: string): number[] {
    const entry = this.repository.find(sku);
    return entry ? entry.prices.map((p) => p.amount) : [];
  }
}
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

// The clones of this kind that the families hold between these two files, in either order.
const clonesBetween = (families, kind, paths) =>
  families
    .flatMap((family) => family.clones)
    .filter((clone) => clone.kind === kind && clone.sides.map((side) => side.path).sort().join() === [...paths].sort().join());

const hasClone = (families, kind, paths) => clonesBetween(families, kind, paths).length > 0;

function writeAll(t, files) {
  t.after(() => Object.keys(files).forEach((path) => rmSync(join(repo, path), { force: true })));
  Object.entries(files).forEach(([path, content]) => write(path, content));
}

function run(args = [], { cwd = repo, script = SCRIPT, env = process.env } = {}) {
  const result = spawnSync("node", [script, ...args], { cwd, env, encoding: "utf8" });
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
    totals: { clones: 0, duplicatedLines: 0, percentage: 0, kinds: ["exact", "similar"] },
    renamed: { report: null, clones: 0 },
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
    summary.bystanders.largest.map((family) => family.fragments.map((f) => [f.path, f.touched])),
    [[["legacy/export_a.js", false], ["legacy/export_b.js", false]]],
  );
  assert.equal(summary.bystanders.largest[0].clones, 1);
  assert.equal(
    clonesIn(summary.families) + summary.bystanders.clones,
    summary.totals.clones + summary.renamed.clones,
  );
});

test("only the languages of the changed files are scanned", () => {
  const { summary } = run();
  const formats = summary.families.flatMap((family) => family.clones).map((clone) => clone.format);
  const paths = [...summary.families, ...summary.bystanders.largest].flatMap((family) =>
    family.fragments.map((f) => f.path),
  );

  assert.deepEqual([...new Set(formats)], ["javascript"]);
  assert.equal(paths.some((path) => path.endsWith(".py")), false);
  assert.equal(summary.totals.clones, 2, "the Python clone is not counted");
});

// jscpd names a plain Markdown code block `text` and a Vue template `html` in
// its statistics, but rejects both names as --format values.
const embeddedBlocks = (ext) => {
  const rows = Array.from({ length: 8 }, (_, i) => `row ${i}: node run.mjs --base main --out report-${i}.json`);
  if (ext === "md") return `# Guide\n\n\`\`\`\n${rows.join("\n")}\n\`\`\`\n`;
  const cells = rows.map((row) => `    <p class="r"><span>${row}</span></p>`).join("\n");
  return `<template>\n  <div>\n${cells}\n  </div>\n</template>\n`;
};

for (const [label, ext, block, host] of [
  ["plain Markdown code block", "md", "text", "markdown"],
  ["Vue template", "vue", "html", "vue"],
]) {
  test(`a copied ${label} is found through the format of its file`, (t) => {
    const content = embeddedBlocks(ext);
    writeAll(t, { [`docs/a.${ext}`]: content, [`docs/b.${ext}`]: content });

    const { status, stderr, summary } = run();

    assert.equal(status, 0, stderr);
    assert.ok(summary.formats.includes(host), summary.formats.join());
    assert.ok(!summary.formats.includes(block), summary.formats.join());
    assert.equal(clonesBetween(summary.families, "exact", [`docs/a.${ext}`, `docs/b.${ext}`])[0]?.format, block);
  });
}

// A stand-in for npx that logs each call's arguments, one JSON array per line.
// `behaviour` is the body of a function that gets `args` and may answer the
// call itself; when it does not, the call goes to the real npx.
function npxSpy(t, behaviour) {
  const binDir = mkdtempSync(join(tmpdir(), "clones-npx-"));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));
  const log = join(binDir, "calls.log");
  const shim = join(binDir, "npx");
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPX_LOG, JSON.stringify(args) + "\\n");
${behaviour}
const real = spawnSync("npx", args, { env: { ...process.env, PATH: process.env.ORIG_PATH }, stdio: "inherit" });
process.exit(real.status ?? 1);
`,
  );
  chmodSync(shim, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORIG_PATH: process.env.PATH, NPX_LOG: log };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { env, calls };
}

const emptySummary = (changedFiles) => ({
  jscpd: JSCPD_VERSION,
  base,
  changedFiles,
  formats: [],
  report: null,
  totals: { clones: 0, duplicatedLines: 0, percentage: 0, kinds: ["exact", "similar"] },
  renamed: { report: null, clones: 0 },
  families: [],
  bystanders: { count: 0, clones: 0, largest: [] },
});

const noCloneReports = () => [
  existsSync(join(repo, ".git", "jscpd-out", "jscpd-report.json")),
  existsSync(join(repo, ".git", "jscpd-out", "renamed-report.json")),
];

test("when the format probe finds no formats, jscpd --list is not run and the summary is empty", (t) => {
  t.after(() => {
    rmSync(join(repo, "data.xyz"), { force: true });
    git("switch", "--quiet", "change");
  });
  git("switch", "--quiet", "main");
  write("data.xyz", "not source code\n");
  const { env, calls } = npxSpy(t, "");

  const { status, stderr, summary } = run([], { env });

  assert.equal(status, 0, stderr);
  assert.deepEqual(summary, emptySummary(1));
  assert.equal(calls().length, 1);
  assert.ok(calls()[0].includes("changed-formats"));
  assert.ok(calls().every((args) => !args.includes("--list")));
  assert.deepEqual(noCloneReports(), [false, false]);
});

test("when no probed format is one that --list names, both clone scans are skipped and the summary is empty", (t) => {
  const { env, calls } = npxSpy(
    t,
    `if (args.includes("--list")) {
  process.stdout.write("markdown\\nvue\\n");
  process.exit(0);
}
if (args.includes("changed-formats")) {
  const outDir = args[args.indexOf("--output") + 1];
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outDir + "/changed-formats.json", JSON.stringify({ duplicates: [], statistics: { formats: { text: {}, html: {} } } }));
  process.exit(0);
}
process.stderr.write("unexpected clone scan\\n");
process.exit(1);`,
  );

  const { status, stderr, summary } = run([], { env });

  assert.equal(status, 0, stderr);
  assert.deepEqual(summary, emptySummary(1));
  assert.equal(calls().length, 2);
  assert.ok(calls()[0].includes("changed-formats"));
  assert.ok(calls()[1].includes("--list"));
  assert.ok(!calls()[1].includes("--config"), "the list does not depend on the repository's config");
  assert.deepEqual(noCloneReports(), [false, false]);
});

test("the report lands in the git directory and the working tree stays clean", () => {
  const { summary } = run();

  assert.equal(summary.report, join(repo, ".git", "jscpd-out", "jscpd-report.json"));
  assert.ok(existsSync(summary.report));
  assert.equal(summary.renamed.report, join(repo, ".git", "jscpd-out", "renamed-report.json"));
  assert.ok(existsSync(summary.renamed.report));
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
function assertKebabFailOnEmptyScansNoFiles(t, configPath) {
  const configEntry = configPath.split("/")[0];
  t.after(() => {
    rmSync(join(repo, configEntry), { recursive: true, force: true });
    rmSync(join(repo, "data.xyz"), { force: true });
    rmSync(join(repo, ".git", "info", "exclude"), { force: true });
    git("switch", "--quiet", "change");
  });
  git("switch", "--quiet", "main");
  // Keep the config out of the diff, so that data.xyz is the only change.
  write(".git/info/exclude", `${configEntry}\n`);
  write(configPath, JSON.stringify({ "fail-on-empty": true }));
  write("data.xyz", "not source code\n");

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.deepEqual(summary.formats, []);
}

test("kebab-case fail-on-empty in .jscpd.json does not fail a scan of no files", (t) => {
  assertKebabFailOnEmptyScansNoFiles(t, ".jscpd.json");
});

test("exit-code gates under package.json's jscpd key do not fail the scan", (t) => {
  t.after(() => rmSync(join(repo, "package.json"), { force: true }));
  write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      jscpd: {
        baseline: ".jscpd-baseline.json",
        baselineFromRef: "no-such-ref",
        threshold: 0,
        exitCode: 2,
        failOnNewClones: 0,
        failOnEmpty: true,
        "baseline-from-ref": "no-such-ref",
        "exit-code": 2,
        "fail-on-new-clones": 0,
        "fail-on-empty": true,
      },
    }),
  );

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.ok(summary.families.length >= 1);
});

// With "absolute": true, jscpd reports absolute paths. Those match none of the
// changed files, so every family would turn into a bystander. The space in
// the copy's name and the run through a symlinked checkout come from the
// acceptance criteria of #46, and both pass without the fix. They guard
// against a different fix, one that would rewrite jscpd's absolute paths
// relative to the working directory. That rewrite can go wrong for a path
// with a space or for a working directory reached through a symlink.
function configBody(source, config) {
  if (source === "package.json") return { name: "fixture", jscpd: config };
  return config;
}

for (const source of [".jscpd.json", ".config/jscpd.json", ".config/.jscpd.json", "package.json"]) {
  test(`absolute: true in ${source} does not change the summary`, (t) => {
    const links = mkdtempSync(join(tmpdir(), "clones-checkout-"));
    t.after(() => {
      rmSync(join(repo, source), { force: true });
      rmSync(join(repo, ".config"), { recursive: true, force: true });
      rmSync(join(repo, "src", "invoice copy.js"), { force: true });
      rmSync(links, { recursive: true, force: true });
    });
    // An untracked exact copy of a committed file, with a space in its name.
    write("src/invoice copy.js", totalFunction("invoiceTotal"));
    // The config file is itself a change, so both runs need one.
    write(source, JSON.stringify(configBody(source, {})));
    const plain = run();
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(
      plain.summary.families[0].fragments.some((f) => f.path === "src/invoice copy.js" && f.touched),
    );

    write(source, JSON.stringify(configBody(source, { absolute: true })));
    const absolute = run();
    symlinkSync(repo, join(links, "checkout"));
    const throughSymlink = run([], { cwd: join(links, "checkout") });

    assert.equal(absolute.status, 0, absolute.stderr);
    assert.deepEqual(absolute.summary, plain.summary);
    assert.equal(throughSymlink.status, 0, throughSymlink.stderr);
    assert.deepEqual(throughSymlink.summary, plain.summary);
  });
}

// Each of these settings switches jscpd 5.4.3 away from the scan the script
// wants. semantic fails the scan unless a model is downloaded, deadCode makes
// jscpd write a dead-code report instead of a clone report, and kind drops
// clones of the other kinds. A kind that is not a list fails the scan. The
// empty JSCPD_CACHE_DIR hides any model the developer has downloaded, so
// semantic fails the same way on every machine and never downloads one.
const MODE_SETTINGS = [
  { semantic: true },
  { semantic: { enabled: true } },
  { deadCode: true },
  { "dead-code": true },
  { kind: ["renamed"] },
  { kind: "renamed" },
];

for (const source of [".jscpd.json", "package.json"]) {
  for (const setting of MODE_SETTINGS) {
    test(`${JSON.stringify(setting)} in ${source} does not change the summary`, (t) => {
      const cache = mkdtempSync(join(tmpdir(), "clones-jscpd-cache-"));
      t.after(() => {
        rmSync(join(repo, source), { force: true });
        rmSync(cache, { recursive: true, force: true });
      });
      const env = { ...process.env, JSCPD_CACHE_DIR: cache };
      write(source, JSON.stringify(configBody(source, {})));
      const plain = run([], { env });
      assert.equal(plain.status, 0, plain.stderr);
      assert.ok(plain.summary.totals.clones >= 1);

      write(source, JSON.stringify(configBody(source, setting)));
      const withSetting = run([], { env });

      assert.equal(withSetting.status, 0, withSetting.stderr);
      assert.deepEqual(withSetting.summary, plain.summary);
    });
  }
}

// A repo's reportName renames the file jscpd writes. The script names both of
// its reports on the command line, so the setting changes neither of them.
// Both spellings in one file fail a scan given that file with --config, so the
// script strips them.
const REPORT_NAME_SETTINGS = [
  { reportName: "custom" },
  { "report-name": "custom" },
  { reportName: "custom", "report-name": "custom" },
];

for (const source of [".jscpd.json", "package.json"]) {
  for (const setting of REPORT_NAME_SETTINGS) {
    test(`${JSON.stringify(setting)} in ${source} does not change the summary`, (t) => {
      t.after(() => rmSync(join(repo, source), { force: true }));
      write(source, JSON.stringify(configBody(source, {})));
      const plain = run();
      assert.equal(plain.status, 0, plain.stderr);
      assert.ok(plain.summary.families.length >= 1);

      write(source, JSON.stringify(configBody(source, setting)));
      const withSetting = run();

      assert.equal(withSetting.status, 0, withSetting.stderr);
      assert.deepEqual(withSetting.summary, plain.summary);
      assert.ok(existsSync(withSetting.summary.report));
      assert.deepEqual(readdirSync(join(repo, ".git", "jscpd-out")).sort(), [
        "changed-formats.json",
        "config.json",
        "jscpd-report.json",
        "renamed-report.json",
      ]);
      assert.equal(git("status", "--short", "--untracked-files=all"), `?? ${source}`);
    });
  }
}

// A repo's history settings make jscpd 5.4.3 rescan past commits in temporary
// worktrees and add a history field to the report, which the script does not
// use. A range or date that selects nothing fails the scan; the fixture has
// only two commits, so HEAD~5..HEAD does not exist.
const HISTORY_SETTINGS = [
  { history: "HEAD~5..HEAD" },
  { historySince: "not-a-date" },
  { "history-since": "not-a-date" },
];

for (const source of [".jscpd.json", "package.json"]) {
  for (const setting of HISTORY_SETTINGS) {
    test(`${JSON.stringify(setting)} in ${source} does not change the summary`, (t) => {
      t.after(() => rmSync(join(repo, source), { force: true }));
      write(source, JSON.stringify(configBody(source, {})));
      const plain = run();
      assert.equal(plain.status, 0, plain.stderr);
      assert.ok(plain.summary.families.length >= 1);

      write(source, JSON.stringify(configBody(source, setting)));
      const withSetting = run();

      assert.equal(withSetting.status, 0, withSetting.stderr);
      assert.deepEqual(withSetting.summary, plain.summary);
      const report = JSON.parse(readFileSync(withSetting.summary.report, "utf8"));
      assert.equal("history" in report, false);
      assert.deepEqual(readdirSync(join(repo, ".git", "jscpd-out")).sort(), [
        "changed-formats.json",
        "config.json",
        "jscpd-report.json",
        "renamed-report.json",
      ]);
      assert.equal(git("worktree", "list").split("\n").length, 1);
      assert.equal(git("status", "--short", "--untracked-files=all"), `?? ${source}`);
    });
  }
}

// With identifiers, literals or annotations normalized, jscpd 5.4.3 pairs each
// copy with one anchor, so a normalized copy that sorts first takes the place
// of an exact pair whose whole range it matches. In this fixture
// src/basket.js renames src/invoice.js, which src/order.js copies exactly,
// tests/bulk.test.js changes the prices of tests/cart.test.js and its exact
// copy, and src/a_controller.ts adds a decorator to two exact copies.
const NORMALIZATION_SETTINGS = [
  { ignoreIdentifiers: true },
  { "ignore-identifiers": true },
  { ignoreLiterals: true },
  { "ignore-literals": true },
  { ignoreAnnotations: true },
  { "ignore-annotations": true },
];

const NORMALIZATION_FIXTURE = {
  "src/basket.js": renamedTotalFunction,
  "tests/bulk.test.js": cartTest([3.5, 14, 35]),
  "tests/cart.test.js": cartTest(),
  "tests/copy.test.js": cartTest(),
  "src/a_controller.ts": priceController('@Get(":sku")'),
  "src/b_controller.ts": priceController(),
  "src/c_controller.ts": priceController(),
};

// Runs the review with an empty config in `source`, then with each setting in
// turn, asserts that no setting changes the summary, and returns that summary.
function assertSummaryUnchangedBy(t, source, settings) {
  t.after(() => rmSync(join(repo, source), { force: true }));
  write(source, JSON.stringify(configBody(source, {})));
  const plain = run();
  assert.equal(plain.status, 0, plain.stderr);

  for (const setting of settings) {
    write(source, JSON.stringify(configBody(source, setting)));
    const withSetting = run();

    assert.equal(withSetting.status, 0, withSetting.stderr);
    assert.deepEqual(withSetting.summary, plain.summary, JSON.stringify(setting));
  }
  return plain.summary;
}

for (const source of [".jscpd.json", "package.json"]) {
  test(`identifier, literal and annotation settings in ${source} keep exact pairs exact`, (t) => {
    writeAll(t, NORMALIZATION_FIXTURE);

    const { families } = assertSummaryUnchangedBy(t, source, NORMALIZATION_SETTINGS);

    assert.ok(hasClone(families, "exact", ["src/invoice.js", "src/order.js"]));
    assert.ok(hasClone(families, "exact", ["tests/cart.test.js", "tests/copy.test.js"]));
    assert.ok(hasClone(families, "exact", ["src/b_controller.ts", "src/c_controller.ts"]));
  });
}

// A gap setting would merge the two renamed blocks of the server fixture into
// one similar clone, which the renamed scan's --kind renamed then drops. With
// no gap, the first scan would split the gap clone of the setup functions into
// two exact ones, and match the pair by syntax tree instead. Both spellings in
// one file fail a scan given that file with --config, so both are stripped.
for (const source of [".jscpd.json", "package.json"]) {
  test(`a gap setting in ${source}, in one spelling or both, leaves each scan's own gap`, (t) => {
    writeAll(t, { ...SERVER_FIXTURE, ...GAP_FIXTURE });

    const { families } = assertSummaryUnchangedBy(t, source, [
      { maxGapLines: 3 },
      { "max-gap-lines": 3 },
      { maxGapLines: 0, "max-gap-lines": 0 },
    ]);

    assert.equal(clonesBetween(families, "renamed", ["src/server_a.js", "src/server_b.js"]).length, 2);
    assert.deepEqual(
      clonesBetween(families, "similar", ["src/setup_a.js", "src/setup_b.js"]).map((clone) => clone.method),
      ["gap"],
    );
  });
}

for (const dotConfig of [".config/jscpd.json", ".config/.jscpd.json"]) {
  test(`${dotConfig} keeps thresholds and ignores while stripping camelCase gates`, (t) => {
    t.after(() => rmSync(join(repo, ".config"), { recursive: true, force: true }));
    write(
      dotConfig,
      JSON.stringify({
        ignore: ["**/legacy/**"],
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
    assert.equal(summary.families.length, 1);
    assert.equal(summary.bystanders.count, 0, "ignore pattern survived");
    assert.equal(summary.totals.clones, 1);

    write(dotConfig, JSON.stringify({ minLines: 50, failOnEmpty: true }));
    const thresholded = run();

    assert.equal(thresholded.status, 0, thresholded.stderr);
    assert.equal(thresholded.summary.totals.clones, 0, "minLines threshold survived");
  });

  test(`${dotConfig} keeps kebab-case thresholds and ignores while stripping kebab-case gates`, (t) => {
    t.after(() => rmSync(join(repo, ".config"), { recursive: true, force: true }));
    write(
      dotConfig,
      JSON.stringify({
        ignore: ["**/legacy/**"],
        "baseline-from-ref": "no-such-ref",
        "exit-code": 2,
        "fail-on-new-clones": 0,
      }),
    );

    const { status, stderr, summary } = run();

    assert.equal(status, 0, stderr);
    assert.equal(summary.families.length, 1);
    assert.equal(summary.bystanders.count, 0);

    write(dotConfig, JSON.stringify({ "min-lines": 50 }));
    const thresholded = run();

    assert.equal(thresholded.status, 0, thresholded.stderr);
    assert.equal(thresholded.summary.totals.clones, 0);
  });

  test(`kebab-case fail-on-empty in ${dotConfig} does not fail a scan of no files`, (t) => {
    assertKebabFailOnEmptyScansNoFiles(t, dotConfig);
  });

  test(`invalid ${dotConfig} fails with a message naming its source`, (t) => {
    t.after(() => {
      rmSync(join(repo, ".config"), { recursive: true, force: true });
      rmSync(join(repo, "package.json"), { force: true });
    });
    write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));
    write(dotConfig, "{not valid json");

    const invalidJson = run();

    assert.equal(invalidJson.status, 1);
    assert.match(invalidJson.stderr, new RegExp(`Invalid ${dotConfig.replaceAll(".", "\\.")}:`));

    write(dotConfig, "[]");
    const nonObject = run();

    assert.equal(nonObject.status, 1);
    assert.match(
      nonObject.stderr,
      new RegExp(`Invalid ${dotConfig.replaceAll(".", "\\.")}: expected a JSON object\\.`),
    );
  });

  // Under --config, jscpd rejects the whole file over one ill-typed field,
  // and its message names the sanitized copy rather than the file to fix.
  test(`a field jscpd rejects in ${dotConfig} fails with a message naming its source`, (t) => {
    t.after(() => rmSync(join(repo, ".config"), { recursive: true, force: true }));
    write(dotConfig, JSON.stringify({ minLines: 50, entry: "src/index.js" }));

    const { status, stderr } = run();

    assert.equal(status, 1);
    assert.match(stderr, /invalid type/);
    assert.match(stderr, new RegExp(`from ${dotConfig.replaceAll(".", "\\.")}`));
  });
}

test("config precedence matches jscpd: .jscpd.json > .config/jscpd.json > .config/.jscpd.json > package.json", (t) => {
  t.after(() => {
    rmSync(join(repo, ".jscpd.json"), { force: true });
    rmSync(join(repo, ".config"), { recursive: true, force: true });
    rmSync(join(repo, "package.json"), { force: true });
  });

  // Root .jscpd.json wins over both dot-config files and package.json.
  write(".jscpd.json", JSON.stringify({}));
  write(".config/jscpd.json", JSON.stringify({ minLines: 50 }));
  write(".config/.jscpd.json", JSON.stringify({ minLines: 50 }));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));
  assert.ok(run().summary.totals.clones > 0, ".jscpd.json wins over dot-config and package.json");

  // .config/jscpd.json wins over .config/.jscpd.json and package.json.
  rmSync(join(repo, ".jscpd.json"), { force: true });
  write(".config/jscpd.json", JSON.stringify({ minLines: 50 }));
  write(".config/.jscpd.json", JSON.stringify({ minLines: 5 }));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 5 } }));
  assert.equal(run().summary.totals.clones, 0, ".config/jscpd.json wins over .config/.jscpd.json and package.json");

  // .config/.jscpd.json wins over package.json.
  rmSync(join(repo, ".config/jscpd.json"), { force: true });
  write(".config/.jscpd.json", JSON.stringify({ minLines: 50 }));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 5 } }));
  assert.equal(run().summary.totals.clones, 0, ".config/.jscpd.json wins over package.json");

  // And an empty dot-config still shadows package.json's thresholds.
  write(".config/.jscpd.json", JSON.stringify({}));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));
  assert.ok(run().summary.totals.clones > 0, "empty .config/.jscpd.json shadows package.json");
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

// jscpd only warns about this value in a file it discovers itself, but the
// script passes the sanitized copy with --config, which jscpd parses strictly.
test("a .jscpd.json value of the wrong type fails with a message that names the file and the value", (t) => {
  t.after(() => rmSync(join(repo, ".jscpd.json"), { force: true }));
  write(".jscpd.json", JSON.stringify({ minLines: "x" }));

  const { status, stderr } = run();

  assert.equal(status, 1);
  assert.match(stderr, /"x"/);
  const lastLine = stderr.trimEnd().split("\n").at(-1);
  assert.match(lastLine, /\.jscpd\.json/);
  assert.ok(lastLine.includes(join(repo, ".git", "jscpd-out", "config.json")), lastLine);
  assert.doesNotMatch(lastLine, /CI gates/, "the copy strips more than the CI gates");
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
  assert.equal(clonesIn(summary.families), summary.totals.clones + summary.renamed.clones);
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

test("a similar clone says whether jscpd merged a gap or matched the syntax tree", (t) => {
  writeAll(t, { "src/quote.js": renamedTotalFunction, ...GAP_FIXTURE });

  const { status, stderr, summary } = run();
  const clonesOf = (path) =>
    summary.families
      .flatMap((family) => family.clones)
      .filter((clone) => clone.sides.some((side) => side.path === path))
      .map((clone) => [clone.kind, clone.method]);

  assert.equal(status, 0, stderr);
  assert.deepEqual(clonesOf("src/setup_a.js"), [["similar", "gap"]]);
  assert.deepEqual(clonesOf("src/quote.js"), [["similar", "ast"]]);
});

// src/basket.js renames src/invoice.js and sorts before it and its exact copy
// src/order.js, so a single scan with names normalized would pair basket.js
// with each and lose the exact pair. The renamed scan only adds to the first.
test("a renamed copy of test setup is a renamed clone, and an exact copy keeps its kind and pair", (t) => {
  writeAll(t, {
    "src/basket.js": renamedTotalFunction,
    "tests/basket.test.js": basketTest,
    "tests/cart.test.js": cartTest(),
  });

  const { status, stderr, summary } = run();

  assert.equal(status, 0, stderr);
  assert.ok(hasClone(summary.families, "renamed", ["tests/basket.test.js", "tests/cart.test.js"]), "renamed setup");
  assert.ok(hasClone(summary.families, "exact", ["src/invoice.js", "src/order.js"]), "exact pair");
  assert.equal(
    clonesIn(summary.families) + summary.bystanders.clones,
    summary.totals.clones + summary.renamed.clones,
  );
});

test("a renamed copy of top-level code is found block by block", (t) => {
  writeAll(t, SERVER_FIXTURE);

  const { status, stderr, summary } = run();
  const servers = summary.families.filter((f) => f.fragments.some((x) => x.path === "src/server_a.js"));

  assert.equal(status, 0, stderr);
  assert.deepEqual(
    servers.map((f) => f.clones.map((clone) => [clone.kind, ...clone.sides.map((side) => side.path)])),
    [
      [["renamed", "src/server_a.js", "src/server_b.js"]],
      [["renamed", "src/server_a.js", "src/server_b.js"]],
    ],
  );
});

// The first scan merges the two exact blocks of these copies across the
// literal lines into one gap clone. The shorter block, after the gap, is less
// than half of that clone, so it would not count as a repeat of it.
test("the second scan adds no exact block of a gap clone from the first", (t) => {
  writeAll(t, {
    "src/boot_a.js": serverModule("app", "settings", 'logStartup("a");\ntrackBoot("web", 2);'),
    "src/boot_b.js": serverModule("app", "settings", 'logStartup("b");\ntrackBoot("api", 3);'),
  });

  const { status, stderr, summary } = run();
  const boot = summary.families.filter((f) => f.fragments.some((x) => x.path === "src/boot_a.js"));

  assert.equal(status, 0, stderr);
  assert.equal(summary.renamed.clones, 0);
  assert.deepEqual(
    boot.map((f) => f.clones.map((clone) => [clone.kind, clone.method, ...clone.sides.map((side) => side.path)])),
    [[["similar", "gap", "src/boot_a.js", "src/boot_b.js"]]],
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
