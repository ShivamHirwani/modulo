import { test } from "node:test";
import assert from "node:assert/strict";
import { price, prorate, PricingError } from "./pricing.ts";

const ALL4 = ["quote", "bill", "assets", "dept"];

test("10 users, 4 modules, monthly matches prototype ($114.15)", () => {
  const q = price({ moduleIds: ALL4, seats: 10, billing: "monthly", currency: "USD" });
  assert.equal(q.monthlyTotal, 11415);
});

test("annual takes 20% off", () => {
  const q = price({ moduleIds: ALL4, seats: 10, billing: "annual", currency: "USD" });
  assert.equal(q.monthlyTotal, 9132);
  assert.equal(q.periodTotal, 9132 * 12);
});

test("volume discount at 25 and 100 seats", () => {
  const a = price({ moduleIds: [], seats: 25, billing: "monthly", currency: "USD" });
  assert.equal(a.monthlyTotal, 25 * 600 - 1500);
  const b = price({ moduleIds: [], seats: 100, billing: "monthly", currency: "USD" });
  assert.equal(b.monthlyTotal, 100 * 600 - 12000);
});

test("duplicate module ids counted once", () => {
  const q = price({ moduleIds: ["bill", "bill"], seats: 1, billing: "monthly", currency: "USD" });
  assert.equal(q.monthlyTotal, 600 + 1800);
});

test("rejects bad input", () => {
  const bad = (f: () => unknown, code: string) =>
    assert.throws(f, (e: unknown) => e instanceof PricingError && e.code === code);
  bad(() => price({ moduleIds: ["nope"], seats: 1, billing: "monthly", currency: "USD" }), "UNKNOWN_MODULE");
  bad(() => price({ moduleIds: [], seats: 0, billing: "monthly", currency: "USD" }), "BAD_SEATS");
  bad(() => price({ moduleIds: [], seats: 1.5, billing: "monthly", currency: "USD" }), "BAD_SEATS");
  bad(() => price({ moduleIds: [], seats: 301, billing: "monthly", currency: "USD" }), "ENTERPRISE_REQUIRED");
});

test("proration", () => {
  assert.equal(prorate(10000, 16000, 15, 30), 3000);
  assert.equal(prorate(16000, 10000, 15, 30), -3000);
});
