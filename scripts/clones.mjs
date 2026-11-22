#!/usr/bin/env node
// Finds the clones a change is involved in: resolves the diff base, lists the
// changed line ranges, runs jscpd over the whole tree, groups its clones into
// families and splits them into those touching the change and the rest.
// Prints a JSON summary.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Pinned so the same repo gives the same report over time. README "Development"
// says how to bump it.
export const JSCPD_VERSION = "5.4.3";
const JSCPD = `jscpd@${JSCPD_VERSION}`;
const LARGEST_BYSTANDERS = 5;

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads `git diff -U0` output into the line ranges each file has on disk.
 * A hunk that only deletes leaves no lines, so it is recorded as the gap
 * between the two lines that now sit next to each other.
 */
export function parseChangedRanges(diff) {
  const changed = {};
  let path = null;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = newSidePath(line.slice(4));
      continue;
    }
    const hunk = HUNK.exec(line);
    if (!hunk) continue;

    oldLeft = Number(hunk[1] ?? 1);
    newLeft = Number(hunk[3] ?? 1);
    if (path === null) continue;

    const start = Number(hunk[2]);
    const range =
      newLeft === 0
        ? { start, end: start + 1, deletion: true }
        : { start, end: start + newLeft - 1 };
    (changed[path] ??= []).push(range);
  }
  return changed;
}

function newSidePath(raw) {
  let name = raw.replace(/\t$/, "");
  if (name.startsWith('"')) name = unquote(name);
  if (name === "/dev/null") return null;
  return name.replace(/^b\//, "");
}

// Git quotes a path holding special characters as a C string with octal bytes.
function unquote(quoted) {
  const escapes = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  const bytes = [];
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      i++;
      bytes.push(escapes[body[i]] ?? body.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function touches(range, side) {
  if (range.deletion) return side.start <= range.start && range.end <= side.end;
  return range.start <= side.end && side.start <= range.end;
}

// How many of a side's lines fall in added or modified ranges. A deletion
// leaves no lines on disk, so it adds none.
function changedLineCount(ranges, side) {
  return ranges
    .filter((range) => !range.deletion)
    .reduce((sum, range) => {
      const shared = Math.min(range.end, side.end) - Math.max(range.start, side.start) + 1;
      return sum + Math.max(0, shared);
    }, 0);
}

// A clone is introduced when the change wrote at least half of one side.
// Below that, the copy was there before and the change only edited it.
function originOf(located) {
  if (!located.some(({ side }) => side.touched)) return "pre-existing";
  const introduced = located.some(({ side, written }) => written * 2 >= side.end - side.start + 1);
  return introduced ? "introduced" : "pre-existing-edited";
}

/**
 * Reads jscpd's duplicates into clones that keep what the judge needs, marks
 * each side that overlaps a changed range as touched, and gives each clone
 * its origin.
 */
export function readClones(duplicates, changed) {
  return duplicates.map((duplicate) => {
    const located = [duplicate.firstFile, duplicate.secondFile].map((file) => {
      const side = { path: file.name, start: file.start, end: file.end };
      const ranges = changed[side.path] ?? [];
      return {
        side: { ...side, touched: ranges.some((range) => touches(range, side)) },
        written: changedLineCount(ranges, side),
      };
    });
    return {
      format: duplicate.format,
      kind: duplicate.kind,
      lines: duplicate.lines,
      tokens: duplicate.tokens,
      origin: originOf(located),
      ...(duplicate.similarity === undefined ? {} : { similarity: duplicate.similarity }),
      sides: located.map(({ side }) => side),
    };
  });
}

// Largest by the number that `sizeKey` names, then by the position of each item
// in the list that `itemsKey` names.
const largestFirst = (sizeKey, itemsKey) => (a, b) => {
  if (b[sizeKey] !== a[sizeKey]) return b[sizeKey] - a[sizeKey];
  const [first, second] = [a[itemsKey], b[itemsKey]];
  for (let i = 0; i < Math.min(first.length, second.length); i++) {
    const order = byPosition(first[i], second[i]);
    if (order !== 0) return order;
  }
  return first.length - second.length;
};

// Two sides in one file are the same fragment when they share at least half of
// the shorter one. That absorbs the small shifts between jscpd's ranges for one
// copy, while a few shared edge lines do not chain unrelated clones together.
// The rule is applied pair by pair and is transitive, so a run of sides that
// each overlap the next by half (1-10, 6-15, 11-20) still becomes one fragment,
// and the two sides of a clone that overlaps itself become one. The model
// splits such a family.
function sameFragment(a, b) {
  if (a.path !== b.path) return false;
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1;
  const shorter = Math.min(a.end - a.start, b.end - b.start) + 1;
  return shared * 2 >= shorter;
}

/**
 * Groups clones into candidate families: fragments are nodes, clones are
 * edges, and each connected component is a family. jscpd pairs every copy
 * with one anchor only, so a four-way copy arrives as three clones.
 * A family is involved when any of its clones touches the change.
 */
export function candidateFamilies(clones) {
  // readClones gives every clone exactly two sides, so clone c owns sides 2c and 2c + 1.
  const sides = clones.flatMap((clone) => clone.sides);
  const fragmentOf = disjointSets(sides.length);
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      if (sameFragment(sides[i], sides[j])) fragmentOf.union(i, j);
    }
  }
  // Families join fragments, so they are built over fragment roots.
  const familyOf = disjointSets(sides.length);
  clones.forEach((_, c) => familyOf.union(fragmentOf.find(2 * c), fragmentOf.find(2 * c + 1)));

  const groups = new Map();
  clones.forEach((clone, c) => {
    const root = familyOf.find(fragmentOf.find(2 * c));
    const group = groups.get(root) ?? groups.set(root, { clones: [], fragments: new Map() }).get(root);
    group.clones.push(clone);
    for (const i of [2 * c, 2 * c + 1]) {
      const key = fragmentOf.find(i);
      group.fragments.set(key, widen(group.fragments.get(key), sides[i]));
    }
  });

  const families = [...groups.values()]
    .map((group) => {
      const clones = group.clones.sort(largestFirst("lines", "sides"));
      const fragments = [...group.fragments.values()].sort(byPosition);
      const duplicatedLines = fragments.reduce((sum, f) => sum + f.end - f.start + 1, 0);
      return { lines: clones[0].lines, duplicatedLines, fragments, clones };
    })
    .sort(largestFirst("duplicatedLines", "fragments"));
  const involved = (family) => family.fragments.some((fragment) => fragment.touched);
  return {
    involved: families.filter(involved),
    bystanders: families.filter((family) => !involved(family)),
  };
}

function disjointSets(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  return { find, union: (i, j) => void (parent[find(i)] = find(j)) };
}

// Widens a fragment to cover one more of its sides; it is touched if any side is.
function widen(fragment, side) {
  if (!fragment) return { ...side };
  return {
    path: side.path,
    start: Math.min(fragment.start, side.start),
    end: Math.max(fragment.end, side.end),
    touched: fragment.touched || side.touched,
  };
}

function byPosition(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.start !== b.start) return a.start - b.start;
  return a.end - b.end;
}

/**
 * Builds the summary from jscpd's report and the changed line ranges. With no
 * formats to scan there is no report, and the summary is empty.
 */
export function summarize(report, changed, { base, formats, jscpd, reportPath }) {
  const summary = {
    jscpd,
    base,
    changedFiles: Object.keys(changed).length,
    formats,
    report: null,
    totals: { clones: 0, duplicatedLines: 0, percentage: 0 },
    families: [],
    bystanders: { count: 0, clones: 0, largest: [] },
  };
  if (formats.length === 0) return summary;

  const grouped = candidateFamilies(readClones(report.duplicates, changed));
  const { clones, duplicatedLines, percentage } = report.statistics.total;

  return {
    ...summary,
    report: reportPath,
    totals: { clones, duplicatedLines, percentage },
    families: grouped.involved,
    bystanders: {
      count: grouped.bystanders.length,
      clones: grouped.bystanders.reduce((sum, family) => sum + family.clones.length, 0),
      largest: grouped.bystanders.slice(0, LARGEST_BYSTANDERS),
    },
  };
}

class Failure extends Error {}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(root, ...args) {
  try {
    return git(root, ...args).trim();
  } catch {
    return null;
  }
}

function resolveBase(root, requested) {
  const candidates = requested
    ? [requested]
    : [
        tryGit(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
        "origin/main",
        "origin/master",
        "main",
        "master",
      ];
  for (const ref of candidates) {
    const base = ref && tryGit(root, "merge-base", "HEAD", ref);
    if (base) return base;
  }
  throw new Failure(
    requested
      ? `No merge base between HEAD and '${requested}'.`
      : "Could not find the default branch. Pass --base <ref>.",
  );
}

function changedRanges(root, base) {
  const diff = git(
    root,
    "-c", "core.quotePath=false",
    "diff", "-U0", "--no-color", "--no-ext-diff",
    "--src-prefix=a/", "--dst-prefix=b/",
    base,
  );
  const changed = parseChangedRanges(diff);
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z");
  for (const path of untracked.split("\0").filter(Boolean)) {
    changed[path] = [{ start: 1, end: Infinity }];
  }
  return changed;
}

function jscpd(root, args) {
  const run = spawnSync("npx", ["--yes", JSCPD, ...args, "--silent"], {
    cwd: root,
    encoding: "utf8",
  });
  if (run.error) throw new Failure(`Could not run npx: ${run.error.message}`);
  // jscpd 5.4.3 exits non-zero whenever it prints "Error:". The pattern check
  // is kept as a guard in case another version prints it and exits 0.
  const output = `${run.stdout}${run.stderr}`.trim();
  if (run.signal || run.status !== 0 || /^Error:/m.test(output)) {
    throw new Failure(`jscpd failed:\n${output || `terminated by ${run.signal}`}`);
  }
}

function readReport(outDir, name) {
  const path = join(outDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Failure(
      `jscpd wrote no report at ${path}. If a sandbox blocks that path, ` +
        "grant write access to it rather than moving the report into the working tree.",
    );
  }
  return { path, report: JSON.parse(readFileSync(path, "utf8")) };
}

// Settings that make jscpd fail a CI build, or that point it at a baseline of
// the repo's own, would clash with this scan, which only wants the report. A
// baseline would also make jscpd scan a second tree for nothing, since the
// script works out each clone's origin from the diff. The absolute setting
// makes jscpd report absolute paths, which match none of the repo-relative
// changed paths, so every family would look like a bystander. The semantic,
// deadCode and kind settings change what jscpd scans for. semantic fails the
// scan on a machine without an embedding model, deadCode makes jscpd write a
// dead-code report instead of a clone report, and kind drops the clones of
// other kinds (or fails the scan when it is not a list). The history and
// historySince settings make jscpd rescan past commits in temporary worktrees,
// which slows both scans and adds a history field to the report that the
// script does not read. A range or date that selects no commits fails the
// scan. historyEvery and historyLimit only sample those commits and do nothing
// on their own, so they need no entry. jscpd 5.4.3 reads these camelCase
// names from .jscpd.json, .config/jscpd.json, .config/.jscpd.json and
// package.json, and the kebab-case aliases listed here. It calls fail-on-empty
// an unknown field but still applies it. It does not read snake_case
// spellings (history_since was tried), or any other spelling of absolute,
// semantic or kind (semanticEnabled, semantic-enabled and kinds were tried),
// so they need no entry.
const STRIPPED_CONFIG_KEYS = new Set([
  "absolute",
  "semantic",
  "deadCode",
  "dead-code",
  "kind",
  "history",
  "historySince",
  "history-since",
  "threshold",
  "exitCode",
  "exit-code",
  "failOnNewClones",
  "fail-on-new-clones",
  "failOnEmpty",
  "fail-on-empty",
  "baseline",
  "baselineFromRef",
  "baseline-from-ref",
]);

// jscpd 5.4.3 auto-discovers these files in order, then package.json's jscpd
// key, and ignores them all once --config is given.
const CONFIG_FILES = [".jscpd.json", ".config/jscpd.json", ".config/.jscpd.json"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Discovers the repository's jscpd config in jscpd's own precedence order:
 * .jscpd.json, .config/jscpd.json, .config/.jscpd.json, then package.json's
 * jscpd key. Returns the parsed config and its source, relative to root, or
 * null when no config applies.
 */
export function repoConfig(root) {
  for (const source of CONFIG_FILES) {
    const path = join(root, source);
    if (!existsSync(path)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Failure(`Invalid ${source}: ${error.message}`);
    }
    if (!isObject(config)) throw new Failure(`Invalid ${source}: expected a JSON object.`);
    return { source, config };
  }
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const { jscpd } = JSON.parse(readFileSync(path, "utf8")) ?? {};
    return isObject(jscpd) ? { source: "package.json", config: jscpd } : null;
  } catch {
    return null; // jscpd ignores a package.json it cannot parse, so the scan does too.
  }
}

function writeSanitizedConfig(config, outDir) {
  const stripped = Object.fromEntries(
    Object.entries(config).filter(([key]) => !STRIPPED_CONFIG_KEYS.has(key)),
  );
  const target = join(outDir, "config.json");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(target, JSON.stringify(stripped));
  } catch (error) {
    throw new Failure(
      `Could not write ${target} (${error.message}). If a sandbox blocks that path, ` +
        "grant write access to it rather than moving the report into the working tree.",
    );
  }
  return ["--config", target];
}

// jscpd takes format names, not extensions, so it names the changed files' formats itself.
function formatsOf(root, outDir, onDisk, configArgs) {
  jscpd(root, [
    ...onDisk,
    ...configArgs,
    "--min-lines", "1", "--min-tokens", "1",
    "--reporters", "json", "--output", outDir, "--report-name", "changed-formats",
  ]);
  const { report } = readReport(outDir, "changed-formats");
  return Object.keys(report.statistics.formats).sort();
}

function detect(root, outDir, formats, configArgs) {
  jscpd(root, [
    ".",
    ...configArgs,
    "--format", formats.join(","),
    "--similarity", "--max-gap-lines", "3",
    "--reporters", "json", "--output", outDir, "--report-name", "jscpd-report",
  ]);
  return readReport(outDir, "jscpd-report");
}

export function review({ cwd = process.cwd(), base: requested } = {}) {
  const root = tryGit(cwd, "rev-parse", "--show-toplevel");
  if (!root) throw new Failure("Not inside a git repository.");

  const base = resolveBase(root, requested);
  const changed = changedRanges(root, base);
  const outDir = join(git(root, "rev-parse", "--absolute-git-dir").trim(), "jscpd-out");
  rmSync(outDir, { recursive: true, force: true });

  const paths = Object.keys(changed);
  const onDisk = paths.filter((path) => existsSync(join(root, path)));
  const discovered = onDisk.length > 0 ? repoConfig(root) : null;
  const configArgs = discovered ? writeSanitizedConfig(discovered.config, outDir) : [];

  let formats, detected;
  try {
    formats = onDisk.length > 0 ? formatsOf(root, outDir, onDisk, configArgs) : [];
    detected = formats.length > 0 ? detect(root, outDir, formats, configArgs) : null;
  } catch (error) {
    // jscpd's messages name the sanitized copy, which is not the file to fix.
    if (!discovered || !(error instanceof Failure)) throw error;
    throw new Failure(
      `${error.message.trimEnd()}\njscpd read these settings from ${discovered.source}, ` +
        `copied without the CI gates to ${configArgs[1]}.`,
    );
  }
  return summarize(detected?.report ?? null, changed, {
    base,
    formats,
    jscpd: JSCPD_VERSION,
    reportPath: detected?.path,
  });
}

const USAGE = `Usage: clones.mjs [--base <ref>]

Run from inside the repository whose checkout is the change under review.
  --base <ref>  Branch or commit the change is compared with. Defaults to the
                remote's default branch. The diff starts at its merge base
                with HEAD and includes uncommitted and untracked files.`;

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(USAGE);
      return;
    }
    if (argv[i] === "--base" && argv[i + 1]) options.base = argv[++i];
    else throw new Failure(`Unknown or incomplete option '${argv[i]}'.\n\n${USAGE}`);
  }
  console.log(JSON.stringify(review(options), null, 2));
}

// Node resolves symlinks in import.meta.url but not in argv, and an installed
// skill is usually a symlink, so compare real paths.
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
