import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTotals } from "./documents.ts";

test("line math: qty x unit, tax per line, half-up rounding", () => {
  const t = computeTotals([{ description: "a", qty: 3, unitMinor: 1999, taxBps: 1800 }]);
  assert.deepEqual(t.lines[0], { net: 5997, tax: 1079 }); // 1079.46 -> 1079
  assert.equal(t.total, 7076);
});
test("half rounds up (166.5 -> 167)", () => {
  assert.equal(computeTotals([{ description: "a", qty: 0.5, unitMinor: 333, taxBps: 0 }]).subtotal, 167);
});
test("tax per line, not on the sum", () => {
  const t = computeTotals([
    { description: "a", qty: 1, unitMinor: 5, taxBps: 1000 }, // 0.5 -> 1
    { description: "b", qty: 1, unitMinor: 5, taxBps: 1000 }, // 0.5 -> 1
  ]);
  assert.equal(t.tax, 2);
});
test("empty is zero; big values stay exact", () => {
  assert.equal(computeTotals([]).total, 0);
  const t = computeTotals([{ description: "big", qty: 100000, unitMinor: 100_000_000, taxBps: 10000 }]);
  assert.equal(t.subtotal, 1e13); assert.equal(t.total, 2e13);
});
test("rejects qty with more than 3 decimals", () => {
  assert.throws(() => computeTotals([{ description: "a", qty: 1.0005, unitMinor: 1, taxBps: 0 }]));
});
