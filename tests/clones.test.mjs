import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { candidateFamilies, parseChangedRanges, readClones, repoConfig, summarize } from "../scripts/clones.mjs";

const clone = (first, second, extra = {}) => ({
  format: "javascript",
  kind: "exact",
  lines: first[2] - first[1] + 1,
  tokens: 80,
  firstFile: { name: first[0], start: first[1], end: first[2] },
  secondFile: { name: second[0], start: second[1], end: second[2] },
  ...extra,
});

test("added and modified hunks become line ranges on the new side", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "index 111..222 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -3 +3,2 @@ function a() {",
    "-old",
    "+new",
    "+newer",
    "@@ -20,0 +22 @@",
    "+single",
  ].join("\n");

  assert.deepEqual(parseChangedRanges(diff), {
    "src/a.js": [
      { start: 3, end: 4 },
      { start: 22, end: 22 },
    ],
  });
});

test("a pure deletion is recorded as the gap it leaves between two lines", () => {
  const diff = [
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -10,2 +9,0 @@",
    "-gone",
    "-gone too",
  ].join("\n");

  assert.deepEqual(parseChangedRanges(diff), {
    "src/a.js": [{ start: 9, end: 10, deletion: true }],
  });
});

test("a deleted file has no lines on disk, so it has no ranges", () => {
  const diff = [
    "--- a/src/gone.js",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-a",
    "-b",
    "-c",
  ].join("\n");

  assert.deepEqual(parseChangedRanges(diff), {});
});

test("a line of code that looks like a file header is not taken for one", () => {
  const diff = [
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,0 +2,2 @@",
    "+++ b/not-a-file",
    "+@@ -1 +1 @@ not a hunk",
  ].join("\n");

  assert.deepEqual(parseChangedRanges(diff), {
    "notes.md": [{ start: 2, end: 3 }],
  });
});

test("paths with spaces or quoted characters come out as they are on disk", () => {
  const diff = [
    "--- a/my file.js\t",
    "+++ b/my file.js\t",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    '--- "a/tab\\there.js"',
    '+++ "b/tab\\there.js"',
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");

  assert.deepEqual(Object.keys(parseChangedRanges(diff)), [
    "my file.js",
    "tab\there.js",
  ]);
});

const touchedSides = (clones) =>
  clones.map((c) => c.sides.map((s) => [s.path, s.touched]));

test("a side is touched when it overlaps a changed range", () => {
  const changed = { "src/a.js": [{ start: 10, end: 12 }] };
  const first = clone(["src/a.js", 5, 10], ["src/b.js", 1, 6]);
  const second = clone(["src/c.js", 1, 6], ["src/a.js", 12, 30]);
  const untouched = clone(["src/a.js", 13, 30], ["src/b.js", 40, 57]);
  const elsewhere = clone(["src/x.js", 10, 12], ["src/y.js", 10, 12]);

  assert.deepEqual(touchedSides(readClones([first, second, untouched, elsewhere], changed)), [
    [["src/a.js", true], ["src/b.js", false]],
    [["src/c.js", false], ["src/a.js", true]],
    [["src/a.js", false], ["src/b.js", false]],
    [["src/x.js", false], ["src/y.js", false]],
  ]);
});

test("a deletion touches a side only when it falls inside it", () => {
  const changed = { "src/a.js": [{ start: 9, end: 10, deletion: true }] };
  const inside = clone(["src/a.js", 5, 12], ["src/b.js", 1, 8]);
  const endsAtGap = clone(["src/a.js", 1, 9], ["src/c.js", 1, 9]);
  const startsAtGap = clone(["src/a.js", 10, 20], ["src/d.js", 1, 11]);

  assert.deepEqual(
    readClones([inside, endsAtGap, startsAtGap], changed).map((c) => c.sides[0].touched),
    [true, false, false],
  );
});

test("an untracked file is changed in full", () => {
  const changed = { "src/new.js": [{ start: 1, end: Infinity }] };
  const [only] = readClones([clone(["src/old.js", 1, 9], ["src/new.js", 400, 408])], changed);

  assert.equal(only.sides[1].touched, true);
});

const originOf = (duplicate, changed) => readClones([duplicate], changed)[0].origin;

test("a new file that copies an existing function introduces the clone", () => {
  const changed = { "src/new.js": [{ start: 1, end: 12 }] };

  assert.equal(originOf(clone(["src/old.js", 1, 12], ["src/new.js", 1, 12]), changed), "introduced");
});

test("an older clone with one line edited on one side is pre-existing, edited here", () => {
  const changed = { "src/b.js": [{ start: 7, end: 7 }] };

  assert.equal(originOf(clone(["src/a.js", 1, 12], ["src/b.js", 1, 12]), changed), "pre-existing-edited");
});

test("an older clone with only deletions inside it is pre-existing, edited here", () => {
  // Each gap spans the two lines around it, but a deletion leaves no line on disk.
  const gaps = [2, 4, 6, 8].map((start) => ({ start, end: start + 1, deletion: true }));
  const changed = { "src/b.js": gaps };

  assert.equal(originOf(clone(["src/a.js", 1, 12], ["src/b.js", 1, 12]), changed), "pre-existing-edited");
});

test("a clone with a side in an untracked file is introduced", () => {
  const changed = { "src/new.js": [{ start: 1, end: Infinity }] };

  assert.equal(originOf(clone(["src/old.js", 1, 9], ["src/new.js", 400, 408]), changed), "introduced");
});

test("a clone the change does not touch is pre-existing", () => {
  const changed = { "src/c.js": [{ start: 1, end: 12 }] };

  assert.equal(originOf(clone(["src/a.js", 1, 12], ["src/b.js", 1, 12]), changed), "pre-existing");
});

test("a side with half of its lines changed introduces the clone, and one line less does not", () => {
  const side = ["src/b.js", 11, 20];
  const half = { "src/b.js": [{ start: 11, end: 13 }, { start: 18, end: 19 }] };
  const lessThanHalf = { "src/b.js": [{ start: 11, end: 13 }, { start: 18, end: 18 }] };

  assert.equal(originOf(clone(["src/a.js", 1, 10], side), half), "introduced");
  assert.equal(originOf(clone(["src/a.js", 1, 10], side), lessThanHalf), "pre-existing-edited");
});

test("changed lines outside a side do not count toward its share", () => {
  const changed = { "src/b.js": [{ start: 1, end: 12 }] };

  assert.equal(originOf(clone(["src/a.js", 1, 10], ["src/b.js", 10, 19]), changed), "pre-existing-edited");
});

test("clones in a family are ordered largest first, then by locale-independent position", () => {
  // Every clone shares the hub fragment, so all of them form one family.
  const hub = (start) => ["src/hub.js", start, start + 20];
  const small = clone(["src/a.js", 1, 5], hub(100));
  const bigLate = clone(["src/a.js", 50, 70], hub(100));
  const bigEarlySecondLate = clone(["src/a.js", 20, 40], hub(101));
  const bigEarlySecondEarly = clone(["src/a.js", 20, 40], hub(100));
  const bigUppercase = clone(["src/B.js", 20, 40], hub(100));

  const { bystanders } = families([small, bigLate, bigEarlySecondLate, bigEarlySecondEarly, bigUppercase]);

  assert.equal(bystanders.length, 1);
  assert.deepEqual(
    bystanders[0].clones.map((c) => [c.sides[0].path, c.sides[0].start, c.sides[1].start]),
    [
      ["src/B.js", 20, 100],
      ["src/a.js", 20, 100],
      ["src/a.js", 20, 101],
      ["src/a.js", 50, 100],
      ["src/a.js", 1, 100],
    ],
  );
});

test("each clone keeps what the judge needs and drops the rest", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const clones = readClones(
    [clone(["src/a.js", 1, 9], ["src/b.js", 11, 19], { isNew: true, fragment: "..." })],
    changed,
  );

  assert.deepEqual(clones, [
    {
      format: "javascript",
      kind: "exact",
      lines: 9,
      tokens: 80,
      origin: "pre-existing-edited",
      sides: [
        { path: "src/a.js", start: 1, end: 9, touched: true },
        { path: "src/b.js", start: 11, end: 19, touched: false },
      ],
    },
  ]);
});

test("a similar clone carries its similarity score", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const [only] = readClones(
    [clone(["src/a.js", 1, 9], ["src/b.js", 11, 19], { kind: "similar", similarity: 0.86 })],
    changed,
  );

  assert.equal(only.similarity, 0.86);
});

test("a similar clone keeps the method jscpd found it by", () => {
  const [only] = readClones(
    [clone(["src/a.js", 1, 12], ["src/b.js", 1, 12], { kind: "similar", method: "gap", similarity: 0.974 })],
    {},
  );

  assert.equal(only.method, "gap");
});

const families = (duplicates, changed = {}) => candidateFamilies(readClones(duplicates, changed));

const fragmentsOf = (family) => family.fragments.map((f) => [f.path, f.start, f.end]);

test("one copy reported against one anchor three times is one family of four fragments", () => {
  const changed = { "src/cart.js": [{ start: 1, end: Infinity }] };
  const { involved, bystanders } = families(
    [
      clone(["src/cart.js", 1, 12], ["src/invoice.js", 1, 12]),
      clone(["src/cart.js", 1, 12], ["src/order.js", 1, 12]),
      clone(["src/cart.js", 1, 12], ["src/quote.js", 1, 12]),
    ],
    changed,
  );

  assert.equal(bystanders.length, 0);
  assert.equal(involved.length, 1);
  assert.equal(involved[0].lines, 12);
  assert.equal(involved[0].clones.length, 3);
  assert.deepEqual(involved[0].fragments, [
    { path: "src/cart.js", start: 1, end: 12, touched: true },
    { path: "src/invoice.js", start: 1, end: 12, touched: false },
    { path: "src/order.js", start: 1, end: 12, touched: false },
    { path: "src/quote.js", start: 1, end: 12, touched: false },
  ]);
});

test("two unrelated clones are two families", () => {
  const { bystanders } = families([
    clone(["src/a.js", 1, 9], ["src/b.js", 1, 9]),
    clone(["src/c.js", 1, 9], ["src/d.js", 1, 9]),
  ]);

  assert.deepEqual(bystanders.map(fragmentsOf), [
    [["src/a.js", 1, 9], ["src/b.js", 1, 9]],
    [["src/c.js", 1, 9], ["src/d.js", 1, 9]],
  ]);
});

test("clones at separate places in one file stay separate families", () => {
  const { bystanders } = families([
    clone(["src/a.js", 1, 9], ["src/b.js", 1, 9]),
    clone(["src/a.js", 20, 28], ["src/c.js", 1, 9]),
  ]);

  assert.equal(bystanders.length, 2);
});

test("fragments in one file are one when they share at least half of the shorter one", () => {
  const { bystanders } = families([
    clone(["src/a.js", 1, 10], ["src/b.js", 1, 10]),
    clone(["src/a.js", 6, 20], ["src/c.js", 1, 15]),
  ]);

  assert.equal(bystanders.length, 1);
  assert.deepEqual(fragmentsOf(bystanders[0]), [
    ["src/a.js", 1, 20],
    ["src/b.js", 1, 10],
    ["src/c.js", 1, 15],
  ]);
});

test("a small overlap does not chain clones into one family", () => {
  const { bystanders } = families([
    clone(["src/a.js", 1, 10], ["src/b.js", 1, 10]),
    clone(["src/a.js", 9, 30], ["src/c.js", 1, 22]),
    clone(["src/a.js", 29, 40], ["src/d.js", 1, 12]),
  ]);

  assert.equal(bystanders.length, 3);
});

test("a clone the change does not touch joins the family of a clone it does", () => {
  const changed = { "src/cart.js": [{ start: 1, end: Infinity }] };
  const { involved, bystanders } = families(
    [
      clone(["src/cart.js", 1, 12], ["src/invoice.js", 1, 12]),
      clone(["src/invoice.js", 1, 12], ["src/order.js", 1, 12]),
    ],
    changed,
  );

  assert.equal(bystanders.length, 0);
  assert.equal(involved.length, 1);
  assert.equal(involved[0].clones.length, 2);
});

test("families are ordered largest first, then by position", () => {
  const { bystanders } = families([
    clone(["src/c.js", 1, 5], ["src/d.js", 1, 5]),
    clone(["src/b.js", 1, 20], ["src/c.js", 30, 49]),
    clone(["src/B.js", 1, 20], ["src/e.js", 1, 20]),
    clone(["src/a.js", 1, 5], ["src/e.js", 30, 34]),
  ]);

  assert.deepEqual(bystanders.map((family) => family.fragments[0].path), [
    "src/B.js",
    "src/b.js",
    "src/a.js",
    "src/c.js",
  ]);
});

test("a family's duplicated lines sum its fragments, and order the families", () => {
  const { bystanders } = families([
    clone(["src/a.js", 1, 12], ["src/b.js", 1, 12]),
    clone(["src/a.js", 1, 12], ["src/c.js", 1, 12]),
    clone(["src/x.js", 1, 15], ["src/y.js", 1, 15]),
  ]);

  assert.deepEqual(
    bystanders.map((family) => [family.fragments[0].path, family.lines, family.duplicatedLines]),
    [
      ["src/a.js", 12, 36],
      ["src/x.js", 15, 30],
    ],
  );
});

test("every clone lands in exactly one family", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const duplicates = [
    clone(["src/a.js", 1, 9], ["src/b.js", 1, 9]),
    clone(["src/b.js", 1, 9], ["src/c.js", 1, 9]),
    clone(["src/x.js", 1, 9], ["src/y.js", 1, 9]),
    clone(["src/x.js", 40, 48], ["src/z.js", 1, 9]),
  ];
  const { involved, bystanders } = families(duplicates, changed);
  const all = [...involved, ...bystanders].flatMap((family) => family.clones);

  assert.equal(all.length, duplicates.length);
  assert.equal(new Set(all).size, duplicates.length);
  assert.deepEqual([involved.length, bystanders.length], [1, 2]);
});

test("sides that each overlap the next by half chain into one fragment, a known limit", () => {
  const { bystanders } = families([
    clone(["src/a.js", 1, 10], ["src/b.js", 1, 10]),
    clone(["src/a.js", 6, 15], ["src/c.js", 1, 10]),
    clone(["src/a.js", 11, 20], ["src/d.js", 1, 10]),
  ]);

  assert.deepEqual(bystanders.map(fragmentsOf), [
    [["src/a.js", 1, 20], ["src/b.js", 1, 10], ["src/c.js", 1, 10], ["src/d.js", 1, 10]],
  ]);
});

test("a clone whose sides overlap in one file is a family of one fragment, a known limit", () => {
  const { bystanders } = families([clone(["src/a.js", 1, 10], ["src/a.js", 6, 15])]);

  assert.deepEqual(bystanders.map(fragmentsOf), [[["src/a.js", 1, 15]]]);
  assert.equal(bystanders[0].clones.length, 1);
});

const report = (duplicates, total = {}) => ({
  duplicates,
  statistics: {
    total: { clones: duplicates.length, duplicatedLines: 40, percentage: 12.5, sources: 9, ...total },
  },
});

const options = { base: "abc123", formats: ["javascript"], jscpd: "5.4.3", reportPath: "/out/jscpd-report.json" };

const clonesIn = (families) => families.reduce((sum, family) => sum + family.clones.length, 0);

test("the summary names the scan it comes from", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }], "README.md": [{ start: 1, end: 1 }] };
  const summary = summarize(report([]), changed, options);

  assert.equal(summary.jscpd, "5.4.3");
  assert.equal(summary.base, "abc123");
  assert.equal(summary.changedFiles, 2);
  assert.deepEqual(summary.formats, ["javascript"]);
  assert.equal(summary.report, "/out/jscpd-report.json");
});

test("totals come from the report and equal the clones in families plus bystanders", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const summary = summarize(
    report(
      [
        clone(["src/a.js", 1, 9], ["src/b.js", 1, 9]),
        clone(["src/b.js", 1, 9], ["src/c.js", 1, 9]),
        clone(["src/x.js", 1, 9], ["src/y.js", 1, 9]),
      ],
      { duplicatedLines: 27, percentage: 30 },
    ),
    changed,
    options,
  );

  assert.deepEqual(summary.totals, { clones: 3, duplicatedLines: 27, percentage: 30, kinds: ["exact", "similar"] });
  assert.equal(summary.families.length, 1);
  assert.equal(clonesIn(summary.families) + summary.bystanders.clones, summary.totals.clones);
});

test("bystanders count every untouched family and its clones but list only the five largest", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const duplicates = [
    clone(["src/a.js", 1, 30], ["src/b.js", 1, 30]),
    clone(["src/x.js", 1, 9], ["src/y.js", 1, 9]),
    clone(["src/y.js", 1, 9], ["src/z.js", 1, 9]),
    ...[20, 19, 18, 17, 16].map((lines, i) =>
      clone([`src/f${i}.js`, 1, lines], [`src/g${i}.js`, 1, lines]),
    ),
  ];
  const { families, bystanders } = summarize(report(duplicates), changed, options);

  assert.equal(families.length, 1);
  assert.equal(bystanders.count, 6);
  assert.equal(bystanders.clones, 7);
  assert.deepEqual(bystanders.largest.map((family) => family.lines), [20, 19, 18, 17, 16]);
  assert.deepEqual(bystanders.largest.map((family) => family.clones), [1, 1, 1, 1, 1]);
});

test("bystanders.largest counts each family's clones instead of listing them, keeping fragments and totals intact", () => {
  const changed = { "src/touched.js": [{ start: 1, end: 12 }] };
  const exactCopies = Array.from({ length: 12 }, (_, i) => `src/copy${String(i + 1).padStart(2, "0")}.js`);
  const renamedCopies = Array.from({ length: 3 }, (_, i) => `src/renamed${String(i + 1).padStart(2, "0")}.js`);

  const firstScan = [
    clone(["src/touched.js", 1, 12], ["src/peer1.js", 1, 12]),
    clone(["src/touched.js", 1, 12], ["src/peer2.js", 1, 12]),
    ...exactCopies.map((path) => clone(["src/hub.js", 1, 12], [path, 1, 12])),
    clone(["src/solo_a.js", 1, 10], ["src/solo_b.js", 1, 10]),
  ];
  const secondScan = renamedCopies.map((path) => clone(["src/hub.js", 1, 12], [path, 1, 12]));

  const summary = summarize(report(firstScan), changed, {
    ...options,
    renamed: renamedScan(secondScan),
  });

  const expectedLargeFragments = [...exactCopies, "src/hub.js", ...renamedCopies]
    .sort()
    .map((path) => ({ path, start: 1, end: 12, touched: false }));

  assert.equal(summary.families.length, 1);
  assert.equal(Array.isArray(summary.families[0].clones), true);
  assert.equal(summary.families[0].clones.length, 2);

  assert.equal(summary.bystanders.count, 2);
  assert.equal(summary.bystanders.clones, 16);
  assert.deepEqual(summary.bystanders.largest, [
    {
      lines: 12,
      duplicatedLines: 192,
      fragments: expectedLargeFragments,
      clones: 15,
    },
    {
      lines: 10,
      duplicatedLines: 20,
      fragments: [
        { path: "src/solo_a.js", start: 1, end: 10, touched: false },
        { path: "src/solo_b.js", start: 1, end: 10, touched: false },
      ],
      clones: 1,
    },
  ]);
  assert.equal(
    summary.bystanders.largest.reduce((sum, family) => sum + family.clones, 0),
    summary.bystanders.clones,
  );
  assert.equal(
    clonesIn(summary.families) + summary.bystanders.clones,
    summary.totals.clones + summary.renamed.clones,
  );
});

test("with no formats to scan the summary is empty and needs no report", () => {
  const changed = { "assets/logo.png": [{ start: 1, end: Infinity }] };

  assert.deepEqual(summarize(null, changed, { ...options, formats: [], reportPath: undefined }), {
    jscpd: "5.4.3",
    base: "abc123",
    changedFiles: 1,
    formats: [],
    report: null,
    totals: { clones: 0, duplicatedLines: 0, percentage: 0, kinds: ["exact", "similar"] },
    renamed: { report: null, clones: 0 },
    families: [],
    bystanders: { count: 0, clones: 0, largest: [] },
  });
});

// The renamed scan's report, as review() passes it to summarize.
const renamedScan = (duplicates) => ({
  path: "/out/renamed-report.json",
  report: report(duplicates.map((duplicate) => ({ ...duplicate, kind: "renamed" }))),
});

const clonesOf = (families) =>
  families
    .flatMap((family) => family.clones)
    .map((c) => [c.kind, ...c.sides.map((s) => `${s.path}:${s.start}-${s.end}`)]);

test("a pair that both scans report appears once, with the first scan's kind", () => {
  const changed = { "src/a.js": [{ start: 1, end: Infinity }] };
  const summary = summarize(
    report([clone(["src/a.js", 1, 12], ["src/b.js", 1, 12], { kind: "similar", method: "ast", similarity: 1 })]),
    changed,
    {
      ...options,
      // The same pair the other way round with shifted ranges, and a pair that shares only one side with it.
      renamed: renamedScan([
        clone(["src/b.js", 2, 13], ["src/a.js", 1, 13]),
        clone(["src/a.js", 1, 12], ["src/c.js", 1, 12]),
      ]),
    },
  );

  assert.deepEqual(clonesOf(summary.families), [
    ["similar", "src/a.js:1-12", "src/b.js:1-12"],
    ["renamed", "src/a.js:1-12", "src/c.js:1-12"],
  ]);
  assert.equal(summary.renamed.clones, 1);
});

test("a renamed clone more than twice as long as the clone it overlaps is a pair of its own", () => {
  // The first scan found an exact core; with names normalized, jscpd found the whole copy around it.
  const summary = summarize(
    report([clone(["src/a.js", 11, 30], ["src/b.js", 11, 30])]),
    { "src/a.js": [{ start: 1, end: Infinity }] },
    { ...options, renamed: renamedScan([clone(["src/a.js", 1, 41], ["src/b.js", 1, 41])]) },
  );

  assert.deepEqual(clonesOf(summary.families), [
    ["renamed", "src/a.js:1-41", "src/b.js:1-41"],
    ["exact", "src/a.js:11-30", "src/b.js:11-30"],
  ]);
  assert.deepEqual(fragmentsOf(summary.families[0]), [["src/a.js", 1, 41], ["src/b.js", 1, 41]]);
});

test("a renamed clone that touches the change where the clone it repeats does not stays, so the change keeps its family", () => {
  // The exact pair covers lines 1-10, the renamed pair the whole copy, and only line 15 changed.
  const summary = summarize(
    report([clone(["src/a.js", 1, 10], ["src/b.js", 1, 10])]),
    { "src/a.js": [{ start: 15, end: 15 }] },
    { ...options, renamed: renamedScan([clone(["src/a.js", 1, 20], ["src/b.js", 1, 20])]) },
  );

  assert.deepEqual(clonesOf(summary.families), [
    ["renamed", "src/a.js:1-20", "src/b.js:1-20"],
    ["exact", "src/a.js:1-10", "src/b.js:1-10"],
  ]);
  assert.equal(summary.renamed.clones, 1);
});

test("a renamed clone stays out when the clone it repeats is the one that touches the change", () => {
  // Only line 1 changed: the exact pair covers it, and the renamed pair starts one line later.
  const summary = summarize(
    report([clone(["src/a.js", 1, 12], ["src/b.js", 1, 12])]),
    { "src/a.js": [{ start: 1, end: 1 }] },
    { ...options, renamed: renamedScan([clone(["src/a.js", 2, 13], ["src/b.js", 2, 13])]) },
  );

  assert.deepEqual(clonesOf(summary.families), [["exact", "src/a.js:1-12", "src/b.js:1-12"]]);
  assert.equal(summary.renamed.clones, 0);
});

test("a renamed clone is the same pair while each side shares half of the longer range, and not one line longer", () => {
  const first = report([clone(["src/a.js", 1, 10], ["src/b.js", 1, 10])]);
  const changed = { "src/a.js": [{ start: 1, end: Infinity }] };
  const withRenamedTo = (end) =>
    summarize(first, changed, { ...options, renamed: renamedScan([clone(["src/a.js", 1, end], ["src/b.js", 1, end])]) });

  assert.equal(withRenamedTo(20).renamed.clones, 0, "10 of 20 lines shared");
  assert.equal(withRenamedTo(21).renamed.clones, 1, "10 of 21 lines shared");
});

test("totals count the first scan, and families and bystanders add the renamed clones", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const summary = summarize(
    report(
      [clone(["src/a.js", 1, 9], ["src/b.js", 1, 9]), clone(["src/x.js", 1, 9], ["src/y.js", 1, 9])],
      { duplicatedLines: 18, percentage: 20 },
    ),
    changed,
    {
      ...options,
      renamed: renamedScan([clone(["src/a.js", 1, 9], ["src/c.js", 1, 9]), clone(["src/p.js", 1, 9], ["src/q.js", 1, 9])]),
    },
  );

  assert.deepEqual(summary.totals, { clones: 2, duplicatedLines: 18, percentage: 20, kinds: ["exact", "similar"] });
  assert.deepEqual(summary.renamed, { report: "/out/renamed-report.json", clones: 2 });
  assert.equal(
    clonesIn(summary.families) + summary.bystanders.clones,
    summary.totals.clones + summary.renamed.clones,
  );
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "clones-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (relative, content) => {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  };
  return { dir, write };
}

test("repoConfig returns null when no config file exists", (t) => {
  const { dir } = tempDir(t);

  assert.equal(repoConfig(dir), null);
});

test("repoConfig follows jscpd's precedence order and names its source", (t) => {
  const { dir, write } = tempDir(t);
  write(".jscpd.json", JSON.stringify({ minLines: 11 }));
  write(".config/jscpd.json", JSON.stringify({ minLines: 12 }));
  write(".config/.jscpd.json", JSON.stringify({ minLines: 13 }));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 14 } }));

  assert.deepEqual(repoConfig(dir), {
    source: ".jscpd.json",
    config: { minLines: 11 },
  });

  rmSync(join(dir, ".jscpd.json"));
  assert.deepEqual(repoConfig(dir), {
    source: ".config/jscpd.json",
    config: { minLines: 12 },
  });

  rmSync(join(dir, ".config/jscpd.json"));
  assert.deepEqual(repoConfig(dir), {
    source: ".config/.jscpd.json",
    config: { minLines: 13 },
  });

  rmSync(join(dir, ".config/.jscpd.json"));
  assert.deepEqual(repoConfig(dir), {
    source: "package.json",
    config: { minLines: 14 },
  });
});

test("repoConfig does not fall through from an empty higher-priority config", (t) => {
  const { dir, write } = tempDir(t);
  write(".config/jscpd.json", JSON.stringify({}));
  write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));

  assert.deepEqual(repoConfig(dir), {
    source: ".config/jscpd.json",
    config: {},
  });
});

for (const source of [".jscpd.json", ".config/jscpd.json", ".config/.jscpd.json"]) {
  test(`repoConfig names ${source} when it is invalid JSON or not an object`, (t) => {
    const { dir, write } = tempDir(t);
    write("package.json", JSON.stringify({ name: "fixture", jscpd: { minLines: 50 } }));
    write(source, "{not valid json");

    assert.throws(() => repoConfig(dir), new RegExp(`Invalid ${source.replaceAll(".", "\\.")}:`));

    write(source, "[]");
    assert.throws(
      () => repoConfig(dir),
      new RegExp(`Invalid ${source.replaceAll(".", "\\.")}: expected a JSON object\\.`),
    );
  });
}

test("repoConfig ignores package.json when unparseable or without a jscpd object", (t) => {
  const { dir, write } = tempDir(t);
  write("package.json", "{not valid json");
  assert.equal(repoConfig(dir), null);

  write("package.json", JSON.stringify({ name: "fixture" }));
  assert.equal(repoConfig(dir), null);

  write("package.json", JSON.stringify({ name: "fixture", jscpd: "invalid" }));
  assert.equal(repoConfig(dir), null);
});
