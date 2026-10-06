import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPdf, formatMoney } from "./pdf.ts";
import type { PdfData } from "./pdf.ts";
import { computeTotals } from "./documents.ts";

export const textOf = (buf: Buffer): string => {
  const f = join(mkdtempSync(join(tmpdir(), "pdf-")), "x.pdf");
  writeFileSync(f, buf);
  return execFileSync("pdftotext", ["-layout", f, "-"]).toString();
};
const have = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sk = { skip: have ? false : "pdftotext not installed" };

const sample = (over: Partial<PdfData> = {}, n = 3): PdfData => {
  const items = Array.from({ length: n }, (_, i) => ({ description: `Service ${i + 1}`, qty: i + 1, unitMinor: 100000, taxBps: 1800 }));
  const t = computeTotals(items);
  return {
    kind: "invoice", number: "INV-0007", status: "sent", currency: "INR", date: "2026-10-05", dueDate: "2026-10-19",
    seller: { name: "Seller Pvt Ltd", lines: ["1 Main Road", "Surat"], taxId: "24AAAAA0000A1Z5", paymentInstructions: "UPI: seller@bank", footerNote: "Thank you" },
    customer: { name: "Buyer Co", lines: ["Plot 9, Vapi"] },
    items: items.map((it, i) => ({ ...it, netMinor: t.lines[i].net, taxMinor: t.lines[i].tax })),
    subtotalMinor: t.subtotal, taxMinor: t.tax, totalMinor: t.total, paidMinor: 0, balanceMinor: t.total, ...over,
  };
};

test("money formatting: Indian grouping, code prefix without font, symbol with font", () => {
  assert.equal(formatMoney(12345678, "INR", false), "INR 1,23,456.78");
  assert.equal(formatMoney(12345678, "INR", true), "\u20B91,23,456.78");
  assert.equal(formatMoney(5, "USD", false), "$0.05");
  assert.equal(formatMoney(100000, "EUR", false), "\u20AC1,000.00");
});

test("renders a valid PDF with the right content", sk, async () => {
  const buf = await renderPdf(sample());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  const t = textOf(buf);
  for (const s of ["INVOICE", "INV-0007", "Seller Pvt Ltd", "24AAAAA0000A1Z5", "Buyer Co", "Plot 9, Vapi", "Service 3", "Tax 18%", "Balance due", "UPI: seller@bank", "Page 1 of 1"]) assert.ok(t.includes(s), `missing ${s}`);
  const total = computeTotals([1, 2, 3].map((q) => ({ description: "x", qty: q, unitMinor: 100000, taxBps: 1800 }))).total; // 7,08,000.00 incl tax
  assert.ok(t.includes(formatMoney(total, "INR", false)));
});

test("quote has version, validity, no payment block", sk, async () => {
  const t = textOf(await renderPdf(sample({ kind: "quote", number: "QUO-0002", version: 3, validUntil: "2026-11-04", dueDate: undefined, status: "sent" })));
  assert.ok(t.includes("QUOTATION") && t.includes("v3") && t.includes("2026-11-04") && t.includes("QUO-0002"));
  assert.ok(!t.includes("Balance due") && !t.includes("PAYMENT INSTRUCTIONS"));
});

test("long document paginates and repeats the table header", sk, async () => {
  const t = textOf(await renderPdf(sample({}, 70)));
  const pages = Number(/Page 1 of (\d+)/.exec(t)![1]);
  assert.ok(pages >= 3);
  assert.ok((t.match(/DESCRIPTION/g) ?? []).length >= pages - 1);
  assert.ok(t.includes("Service 70"));
});

test("non-Latin and control characters do not crash or corrupt (built-in font)", sk, async () => {
  const buf = await renderPdf(sample({ customer: { name: "\u0a85\u0aac\u0a95 Traders \u0000\t", lines: ["\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4"] } }));
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(textOf(buf).includes("??? Traders"));
});

test("custom TTF font prints the rupee symbol", sk, async () => {
  const reg = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  if (!existsSync(reg)) return;
  const t = textOf(await renderPdf(sample(), { fontRegular: reg, fontBold: bold }));
  assert.ok(t.includes("\u20B9"));
});
