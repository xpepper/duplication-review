import { test } from "node:test";
import assert from "node:assert/strict";

test("deliberately failing test to show CI turns red (drop before merge)", () => {
  assert.equal(1, 2);
});
