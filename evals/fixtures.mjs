// Fixtures for stability evals of the Extract or Tolerate ruling.
//
// Each fixture builds a throwaway git repository whose change touches one
// family with one defensible expected ruling. Keep comments explaining the
// expected ruling here, outside the fixture files, so the model judges the code
// rather than the comment.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TOTAL_FUNCTION = (name) => `export function ${name}(items, taxRate) {
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

const API_FETCH_FUNCTION = (name, path, extraQueryLine) => `export async function ${name}(client, accountId, options = {}) {
  if (!accountId || typeof accountId !== "string") {
    throw new Error("accountId must be a non-empty string");
  }
  const headers = {
    Authorization: \`Bearer \${client.token}\`,
    "X-Account-Id": accountId,
    "X-Client-Version": client.version,
    Accept: "application/json",
  };
  const query = { limit: options.limit ?? 50, cursor: options.cursor ?? "" };
${extraQueryLine ? `  ${extraQueryLine}\n` : ""}  const response = await client.get("${path}", { headers, query });
  if (response.status === 401) {
    throw new Error("authentication failed for account " + accountId);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") ?? "60";
    throw new Error(\`rate limited; retry after \${retryAfter}s\`);
  }
  if (!response.ok) {
    throw new Error(\`api request failed with status \${response.status}\`);
  }
  const body = await response.json();
  if (body.meta?.deprecated) {
    client.warn("deprecated endpoint", accountId);
  }
  return body.data;
}
`;

const CART_MODULE = `export function createCart({ currency = "EUR", taxRate = 0.2 } = {}) {
  const items = [];
  let coupon = null;
  return {
    addItem(sku, price, quantity) {
      items.push({ sku, price, quantity });
    },
    applyCoupon(code) {
      coupon = code;
    },
    checkout() {
      const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const discount = coupon === "SAVE10" ? Number((subtotal * 0.1).toFixed(2)) : 0;
      const discounted = subtotal - discount;
      const tax = Number((discounted * taxRate).toFixed(2));
      const shipping = discounted >= 100 ? 0 : 9.99;
      return {
        currency,
        subtotal,
        discount,
        tax,
        shipping,
        total: Number((discounted + tax + shipping).toFixed(2)),
      };
    },
  };
}
`;

const SHIPPING_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { createCart } from "../src/cart.js";

test("orders under 100 pay standard shipping", () => {
  const cart = createCart({ currency: "EUR", taxRate: 0.2 });
  cart.addItem("notebook", 12, 2);
  cart.addItem("pen-pack", 5, 4);
  cart.addItem("desk-lamp", 36, 1);
  const receipt = cart.checkout();

  assert.equal(receipt.currency, "EUR");
  assert.equal(receipt.subtotal, 80);
  assert.equal(receipt.discount, 0);
  assert.equal(receipt.tax, 16);
  assert.equal(receipt.shipping, 9.99);
  assert.equal(receipt.total, 105.99);
});
`;

const DISCOUNT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { createCart } from "../src/cart.js";

test("applying SAVE10 reduces discounted total and tax before shipping", () => {
  const cart = createCart({ currency: "EUR", taxRate: 0.2 });
  cart.addItem("notebook", 12, 2);
  cart.addItem("pen-pack", 5, 4);
  cart.addItem("desk-lamp", 36, 1);
  cart.applyCoupon("SAVE10");
  const receipt = cart.checkout();

  assert.equal(receipt.currency, "EUR");
  assert.equal(receipt.subtotal, 80);
  assert.equal(receipt.discount, 8);
  assert.equal(receipt.tax, 14.4);
  assert.equal(receipt.shipping, 9.99);
  assert.equal(receipt.total, 96.39);
});
`;

const OVERFLOW_MODULE = `export function findWarehouseOverflow(bins, binCapacity) {
  let totalExcess = 0;
  let criticalCount = 0;
  const flagged = [];
  for (const bin of bins) {
    if (bin.storedUnits < 0) {
      throw new Error("negative stock for " + bin.binCode);
    }
    if (bin.quarantined) {
      continue;
    }
    const excess = Math.max(0, bin.storedUnits - binCapacity);
    if (excess === 0) {
      continue;
    }
    totalExcess += excess;
    if (bin.storedUnits >= binCapacity + 10) {
      criticalCount += 1;
    }
    flagged.push({ id: bin.binCode, amount: excess });
  }
  return { flagged, totalExcess, criticalCount };
}
`;

const OVERTIME_MODULE = `export function summarizeOvertime(timesheets, standardHours) {
  let totalOvertime = 0;
  let flaggedCount = 0;
  const entries = [];
  for (const sheet of timesheets) {
    if (sheet.loggedHours < 0) {
      throw new Error("negative hours for " + sheet.employeeId);
    }
    if (sheet.salaried) {
      continue;
    }
    const extra = Math.max(0, sheet.loggedHours - standardHours);
    if (extra === 0) {
      continue;
    }
    totalOvertime += extra;
    if (sheet.loggedHours >= standardHours + 10) {
      flaggedCount += 1;
    }
    entries.push({ id: sheet.employeeId, amount: extra });
  }
  return { entries, totalOvertime, flaggedCount };
}
`;

export const FIXTURES = [
  // Expected: Extract.
  // Clear copy of one business rule (quantity check, tax, free-shipping
  // threshold) into a new file under a new function name. Both sides share one
  // reason to change (pricing policy) and read more clearly calling one shared
  // pricing helper.
  {
    name: "copied-rule",
    expected: "Extract",
    expectedClones: ["exact"],
    baseFiles: {
      "src/invoice.js": TOTAL_FUNCTION("invoiceTotal"),
    },
    changeFiles: {
      "src/order.js": TOTAL_FUNCTION("orderTotal"),
    },
  },

  // Expected: Extract.
  // Gap-merged clone between two v2 API client functions in the same domain.
  // Both share auth headers, pagination query setup, status/rate-limit error
  // handling, and response envelope checks, differing only in endpoint path
  // and one optional query filter. Any change to v2 API conventions forces
  // edits in both files, and a shared request helper leaves each endpoint
  // caller concise and clear.
  {
    name: "gap-shared-rule",
    expected: "Extract",
    expectedClones: ["similar/gap", "renamed"],
    baseFiles: {
      "src/api/orders.js": API_FETCH_FUNCTION("fetchOrders", "/v2/orders", null),
    },
    changeFiles: {
      "src/api/invoices.js": API_FETCH_FUNCTION(
        "fetchInvoices",
        "/v2/invoices",
        'if (options.includeVoided) query.voided = "true";',
      ),
    },
  },

  // Expected: Tolerate.
  // Two tests that build the same concrete cart so each test's inputs stay
  // visible next to its assertions, while the differing step (applying the
  // SAVE10 coupon) and expected totals are the point of the new test. Hiding
  // the setup or merging the tests behind a helper obscures what each test
  // proves.
  {
    name: "look-alike-test",
    expected: "Tolerate",
    expectedClones: ["exact"],
    baseFiles: {
      "src/cart.js": CART_MODULE,
      "tests/shipping.test.js": SHIPPING_TEST,
    },
    changeFiles: {
      "tests/discount.test.js": DISCOUNT_TEST,
    },
  },

  // Expected: Tolerate.
  // Structural (ast) clone across two unrelated domains: warehouse bin
  // overflow detection and payroll overtime tracking. They share
  // loop-and-accumulate shape by coincidence only and change for independent
  // domain reasons. Extracting a generic loop helper would couple unrelated
  // domains and hurt readability at both call sites.
  {
    name: "accidental-look-alike",
    expected: "Tolerate",
    expectedClones: ["similar/ast"],
    baseFiles: {
      "src/inventory/overflow.js": OVERFLOW_MODULE,
    },
    changeFiles: {
      "src/payroll/overtime.js": OVERTIME_MODULE,
    },
  },
];

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=eval", "-c", "user.email=eval@example.com", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * Builds a throwaway git repository for one fixture, with baseFiles on main
 * and changeFiles committed on a change branch. Uses neutral directory and
 * commit names so the fixture name never reaches the model. When skillDir is
 * given, links only SKILL.md and scripts/ into .claude/skills/<skillName> and
 * excludes .claude in .git/info/exclude so it never counts as an untracked
 * change.
 */
export function createFixtureRepo(
  fixture,
  { skillDir = null, skillName = "duplication-review-eval" } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eval-")));
  git(dir, "init", "--quiet", "--initial-branch", "main");
  writeFiles(dir, fixture.baseFiles);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "base");
  git(dir, "switch", "--quiet", "--create", "change");
  writeFiles(dir, fixture.changeFiles);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "change");

  if (skillDir) {
    const skillTarget = join(dir, ".claude", "skills", skillName);
    mkdirSync(skillTarget, { recursive: true });
    symlinkSync(join(skillDir, "SKILL.md"), join(skillTarget, "SKILL.md"));
    symlinkSync(join(skillDir, "scripts"), join(skillTarget, "scripts"));
    appendFileSync(join(dir, ".git", "info", "exclude"), "\n.claude\n");
  }
  return dir;
}
