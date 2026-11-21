import { test } from "node:test";
import assert from "node:assert/strict";

import { candidateFamilies, parseChangedRanges, readClones } from "../scripts/clones.mjs";

const clone = (first, second, extra = {}) => ({
  format: "javascript",
  kind: "exact",
  lines: first[2] - first[1] + 1,
  tokens: 80,
  isNew: false,
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

test("clones are ordered largest first, then by locale-independent position", () => {
  const changed = { "src/a.js": [{ start: 1, end: Infinity }], "src/B.js": [{ start: 1, end: Infinity }] };
  const small = clone(["src/a.js", 1, 5], ["src/b.js", 1, 5]);
  const bigLate = clone(["src/a.js", 50, 70], ["src/b.js", 50, 70]);
  const bigEarlySecondLate = clone(["src/a.js", 20, 40], ["src/b.js", 60, 80]);
  const bigEarlySecondEarly = clone(["src/a.js", 20, 40], ["src/b.js", 20, 40]);
  const bigUppercase = clone(["src/B.js", 20, 40], ["src/b.js", 20, 40]);

  const { involved } = families(
    [small, bigLate, bigEarlySecondLate, bigEarlySecondEarly, bigUppercase],
    changed,
  );

  assert.deepEqual(
    involved.flatMap((family) => family.clones).map((c) => [c.sides[0].path, c.sides[0].start, c.sides[1].start]),
    [
      ["src/B.js", 20, 20],
      ["src/a.js", 20, 20],
      ["src/a.js", 20, 60],
      ["src/a.js", 50, 50],
      ["src/a.js", 1, 1],
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
      isNew: true,
      sides: [
        { path: "src/a.js", start: 1, end: 9, touched: true },
        { path: "src/b.js", start: 11, end: 19, touched: false },
      ],
    },
  ]);
});

test("a structural match carries its similarity score", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const [only] = readClones(
    [clone(["src/a.js", 1, 9], ["src/b.js", 11, 19], { kind: "similar", similarity: 0.86 })],
    changed,
  );

  assert.equal(only.similarity, 0.86);
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
