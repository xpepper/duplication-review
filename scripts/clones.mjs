#!/usr/bin/env node
// Finds the clones a change is involved in: resolves the diff base, lists the
// changed line ranges, runs jscpd over the whole tree and splits its clones
// into those touching the change and the rest. Prints a JSON summary.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const JSCPD = "jscpd@5";
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

/**
 * Splits jscpd's clones into those with a side overlapping a changed range
 * and those without. Every clone lands in exactly one list, largest first.
 */
export function partitionClones(duplicates, changed) {
  const involved = [];
  const bystanders = [];

  for (const duplicate of duplicates) {
    const sides = [duplicate.firstFile, duplicate.secondFile].map((file) => {
      const side = { path: file.name, start: file.start, end: file.end };
      const ranges = changed[side.path] ?? [];
      return { ...side, touched: ranges.some((range) => touches(range, side)) };
    });
    const clone = {
      format: duplicate.format,
      kind: duplicate.kind,
      lines: duplicate.lines,
      tokens: duplicate.tokens,
      isNew: duplicate.isNew,
      ...(duplicate.similarity === undefined ? {} : { similarity: duplicate.similarity }),
      sides,
    };
    (sides.some((side) => side.touched) ? involved : bystanders).push(clone);
  }

  return {
    involved: involved.sort(largestFirst),
    bystanders: bystanders.sort(largestFirst),
  };
}

function largestFirst(a, b) {
  return b.lines - a.lines || position(a).localeCompare(position(b));
}

function position(clone) {
  return clone.sides
    .map((side) => `${side.path}:${String(side.start).padStart(9, "0")}`)
    .join(" ");
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
  // jscpd reports a rejected option on its output and still exits 0.
  const output = `${run.stdout}${run.stderr}`.trim();
  if (run.status !== 0 || /^Error:/m.test(output)) {
    throw new Failure(`jscpd failed:\n${output}`);
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

// jscpd takes format names, not extensions, so it names the changed files' formats itself.
function formatsOf(root, outDir, paths) {
  const onDisk = paths.filter((path) => existsSync(join(root, path)));
  if (onDisk.length === 0) return [];
  jscpd(root, [
    ...onDisk,
    "--min-lines", "1", "--min-tokens", "1",
    "--reporters", "json", "--output", outDir, "--report-name", "changed-formats",
  ]);
  const { report } = readReport(outDir, "changed-formats");
  return Object.keys(report.statistics.formats).sort();
}

function detect(root, outDir, base, formats) {
  const thresholds = existsSync(join(root, ".jscpd.json"))
    ? []
    : ["--min-lines", "5", "--min-tokens", "50"];
  jscpd(root, [
    ".",
    "--format", formats.join(","),
    ...thresholds,
    "--similarity", "--max-gap-lines", "3", "--baseline-from-ref", base,
    "--reporters", "json", "--output", outDir,
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

  const summary = {
    base,
    changedFiles: Object.keys(changed).length,
    formats: formatsOf(root, outDir, Object.keys(changed)),
    report: null,
    totals: { clones: 0, duplicatedLines: 0, percentage: 0 },
    involved: [],
    bystanders: { count: 0, largest: [] },
  };
  if (summary.formats.length === 0) return summary;

  const { path, report } = detect(root, outDir, base, summary.formats);
  const { involved, bystanders } = partitionClones(report.duplicates, changed);
  const { clones, duplicatedLines, percentage } = report.statistics.total;

  return {
    ...summary,
    report: path,
    totals: { clones, duplicatedLines, percentage },
    involved,
    bystanders: {
      count: bystanders.length,
      largest: bystanders.slice(0, LARGEST_BYSTANDERS),
    },
  };
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
