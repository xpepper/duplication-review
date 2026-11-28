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
  rmSync,
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

const MERCHANT_POLICY_MODULE = `const ACTIVE_TERMS_VERSION = "2026-04";

export function isEligibleMerchant(merchant) {
  return (
    merchant.status === "active" &&
    merchant.kycTier === "tier2" &&
    merchant.termsVersion === ACTIVE_TERMS_VERSION &&
    merchant.sanctionsStatus === "cleared" &&
    merchant.mfaEnrolled === true &&
    merchant.settlementCurrency === "EUR" &&
    merchant.ibanVerified === true &&
    merchant.riskBand === "low" &&
    merchant.taxIdVerified === true &&
    merchant.beneficialOwnersVerified === true &&
    merchant.payoutHold === false &&
    merchant.chargebackRatioBps <= 100
  );
}

export function canRequestPayout(merchant, amountCents) {
  if (!isEligibleMerchant(merchant)) return false;
  return amountCents >= 1000;
}

export function canIssueInstantTransfer(merchant, amountCents, dailyUsedCents) {
  if (!isEligibleMerchant(merchant)) return false;
  return dailyUsedCents + amountCents <= 250000;
}
`;

const PAYOUT_MINIMUM_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { canRequestPayout } from "../src/merchant-policy.js";

test("rejects payouts below the 10 EUR minimum", () => {
  const merchant = {
    status: "active",
    kycTier: "tier2",
    termsVersion: "2026-04",
    sanctionsStatus: "cleared",
    mfaEnrolled: true,
    settlementCurrency: "EUR",
    ibanVerified: true,
    riskBand: "low",
    taxIdVerified: true,
    beneficialOwnersVerified: true,
    payoutHold: false,
    chargebackRatioBps: 20,
  };

  assert.equal(canRequestPayout(merchant, 999), false);
});
`;

const DAILY_LIMIT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { canIssueInstantTransfer } from "../src/merchant-policy.js";

test("rejects instant transfers over the 2500 EUR daily cap", () => {
  const merchant = {
    status: "active",
    kycTier: "tier2",
    termsVersion: "2026-04",
    sanctionsStatus: "cleared",
    mfaEnrolled: true,
    settlementCurrency: "EUR",
    ibanVerified: true,
    riskBand: "low",
    taxIdVerified: true,
    beneficialOwnersVerified: true,
    payoutHold: false,
    chargebackRatioBps: 20,
  };

  assert.equal(canIssueInstantTransfer(merchant, 60000, 200000), false);
});
`;

const WEB_CANCELLATION_MODULE = `export function calculateWebCancellation(reservation, hoursBeforeStart) {
  if (reservation.paidCents <= 0) {
    throw new Error("web cancellation requires positive paidCents");
  }
  if (hoursBeforeStart < 0) {
    throw new Error("web cancellation requires non-negative hoursBeforeStart");
  }
  let refundRatio = 0;
  let auditTag = "web:no-refund";
  if (hoursBeforeStart >= 48) {
    refundRatio = 1;
    auditTag = "web:full-refund";
  } else if (hoursBeforeStart >= 24) {
    refundRatio = 0.5;
    auditTag = "web:half-refund";
  }
  const grossRefund = Math.round(reservation.paidCents * refundRatio);
  const processingFee = grossRefund > 0 ? Math.min(grossRefund, 1500) : 0;
  const netRefund = grossRefund - processingFee;
  return {
    channel: "web-portal",
    auditTag,
    refundCents: netRefund,
    retainedCents: reservation.paidCents - netRefund,
    feeCents: processingFee,
  };
}
`;

const AGENT_CANCELLATION_MODULE = `export function computeAgentCancellation(booking, hoursUntilCheckIn) {
  if (booking.paidCents <= 0) {
    throw new Error("agent cancellation requires positive paidCents");
  }
  if (hoursUntilCheckIn < 0) {
    throw new Error("agent cancellation requires non-negative hoursUntilCheckIn");
  }
  let refundRate = 0;
  let reasonCode = "agent:no-refund";
  if (hoursUntilCheckIn >= 48) {
    refundRate = 1;
    reasonCode = "agent:full-refund";
  } else if (hoursUntilCheckIn >= 24) {
    refundRate = 0.5;
    reasonCode = "agent:half-refund";
  }
  const rawRefund = Math.round(booking.paidCents * refundRate);
  const handlingFee = rawRefund > 0 ? Math.min(rawRefund, 1500) : 0;
  const finalRefund = rawRefund - handlingFee;
  return {
    channel: "support-agent",
    auditTag: reasonCode,
    refundCents: finalRefund,
    retainedCents: booking.paidCents - finalRefund,
    feeCents: handlingFee,
  };
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

  // Expected: Extract.
  // Two test files repeating a 12-field compliant merchant literal required by
  // isEligibleMerchant, unrelated to each test's distinguishing threshold
  // inputs (999 cents payout minimum vs 60000+200000 daily transfer cap). If
  // the eligibility invariant changes in one test and not the other, the stale
  // rejection test still returns false for the wrong reason and silently stops
  // exercising the limit under test. A shared test factory hides only the
  // eligibility invariant while keeping each test's distinguishing inputs
  // explicit at the call site.
  {
    name: "shared-test-invariant",
    expected: "Extract",
    expectedClones: ["exact"],
    baseFiles: {
      "src/merchant-policy.js": MERCHANT_POLICY_MODULE,
      "tests/payout-minimum.test.js": PAYOUT_MINIMUM_TEST,
    },
    changeFiles: {
      "tests/daily-limit.test.js": DAILY_LIMIT_TEST,
    },
  },

  // Expected: Extract.
  // Structural (ast) clone between two cancellation entry points in the same
  // bookings domain (web portal and support agent) enforcing one refund policy
  // with identical rule literals (48h, 24h, 0.5, 1500 cents fee cap), varying
  // only identifiers and incidental channel labels. Changing a refund tier or
  // fee cap in one without the other would give customers different refunds by
  // channel, and a shared refund helper keeps each channel wrapper concise.
  {
    name: "ast-shared-rule",
    expected: "Extract",
    expectedClones: ["similar/ast"],
    baseFiles: {
      "src/bookings/web-cancellation.js": WEB_CANCELLATION_MODULE,
    },
    changeFiles: {
      "src/bookings/agent-cancellation.js": AGENT_CANCELLATION_MODULE,
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
  try {
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
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      appendFileSync(join(dir, ".git", "info", "exclude"), "\n.claude\n");
    }
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
