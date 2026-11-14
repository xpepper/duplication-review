import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChangedRanges, partitionClones } from "../scripts/clones.mjs";

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

test("a clone is involved when either side overlaps a changed range", () => {
  const changed = { "src/a.js": [{ start: 10, end: 12 }] };
  const first = clone(["src/a.js", 5, 10], ["src/b.js", 1, 6]);
  const second = clone(["src/c.js", 1, 6], ["src/a.js", 12, 30]);
  const untouched = clone(["src/a.js", 13, 30], ["src/b.js", 40, 57]);
  const elsewhere = clone(["src/x.js", 10, 12], ["src/y.js", 10, 12]);

  const { involved, bystanders } = partitionClones(
    [first, second, untouched, elsewhere],
    changed,
  );

  assert.deepEqual(
    involved.map((c) => c.sides.map((s) => [s.path, s.touched])),
    [
      [["src/a.js", true], ["src/b.js", false]],
      [["src/c.js", false], ["src/a.js", true]],
    ],
  );
  assert.equal(bystanders.length, 2);
});

test("a deletion involves a clone only when it falls inside it", () => {
  const changed = { "src/a.js": [{ start: 9, end: 10, deletion: true }] };
  const inside = clone(["src/a.js", 5, 12], ["src/b.js", 1, 8]);
  const endsAtGap = clone(["src/a.js", 1, 9], ["src/c.js", 1, 9]);
  const startsAtGap = clone(["src/a.js", 10, 20], ["src/d.js", 1, 11]);

  const { involved, bystanders } = partitionClones(
    [inside, endsAtGap, startsAtGap],
    changed,
  );

  assert.deepEqual(involved.map((c) => c.sides[1].path), ["src/b.js"]);
  assert.equal(bystanders.length, 2);
});

test("an untracked file is changed in full", () => {
  const changed = { "src/new.js": [{ start: 1, end: Infinity }] };
  const { involved } = partitionClones(
    [clone(["src/old.js", 1, 9], ["src/new.js", 400, 408])],
    changed,
  );

  assert.equal(involved.length, 1);
});

test("both lists are ordered largest first, then by position", () => {
  const changed = { "src/a.js": [{ start: 1, end: Infinity }] };
  const small = clone(["src/a.js", 1, 5], ["src/b.js", 1, 5]);
  const bigLate = clone(["src/a.js", 50, 70], ["src/b.js", 50, 70]);
  const bigEarly = clone(["src/a.js", 20, 40], ["src/b.js", 20, 40]);

  const { involved } = partitionClones([small, bigLate, bigEarly], changed);

  assert.deepEqual(
    involved.map((c) => c.sides[0].start),
    [20, 50, 1],
  );
});

test("each clone keeps what the judge needs and drops the rest", () => {
  const changed = { "src/a.js": [{ start: 1, end: 3 }] };
  const { involved } = partitionClones(
    [clone(["src/a.js", 1, 9], ["src/b.js", 11, 19], { isNew: true, fragment: "..." })],
    changed,
  );

  assert.deepEqual(involved, [
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
  const { involved } = partitionClones(
    [clone(["src/a.js", 1, 9], ["src/b.js", 11, 19], { kind: "similar", similarity: 0.86 })],
    changed,
  );

  assert.equal(involved[0].similarity, 0.86);
});
