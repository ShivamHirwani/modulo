// Quote / invoice PDF. Pure function: data in, Buffer out. No DB, no network.
// Default fonts are the PDF built-ins (Latin-1 + euro). Text outside that becomes "?" unless you pass a TTF
// (e.g. Noto Sans) via PDF_FONT_REGULAR / PDF_FONT_BOLD, which also enables the rupee symbol and other scripts.
import PDFDocument from "pdfkit";

export interface PdfParty { name: string; lines: string[]; taxId?: string | null; email?: string | null; phone?: string | null }
export interface PdfItem { description: string; qty: number; unitMinor: number; taxBps: number; netMinor: number; taxMinor: number }
export interface PdfData {
  kind: "quote" | "invoice";
  number: string | null; version?: number; status: string; currency: string;
  date: string; // quote: created date, invoice: issue date (YYYY-MM-DD)
  dueDate?: string | null; validUntil?: string | null;
  seller: PdfParty & { paymentInstructions?: string | null; footerNote?: string | null };
  customer: PdfParty; attention?: string | null;
  items: PdfItem[];
  subtotalMinor: number; taxMinor: number; totalMinor: number; paidMinor?: number; balanceMinor?: number;
}
export interface PdfOptions { fontRegular?: string; fontBold?: string }

const W = 595.28, H = 841.89, M = 48, CW = W - 2 * M;
const INK = "#111111", GRAY = "#666666", LINE = "#dddddd", FILL = "#e9faf0";
const STAMPS: Record<string, [string, string]> = {
  draft: ["DRAFT", "#555555"], void: ["VOID", "#b91c1c"], paid: ["PAID", "#15803d"],
  superseded: ["SUPERSEDED", "#555555"], rejected: ["REJECTED", "#b91c1c"], expired: ["EXPIRED", "#c2410c"],
};

const LOCALE: Record<string, string> = { INR: "en-IN", USD: "en-US", EUR: "en-IE" };
const SYMBOL: Record<string, string> = { INR: "\u20B9", USD: "$", EUR: "\u20AC" };

export function formatMoney(minor: number, currency: string, unicode: boolean): string {
  const neg = minor < 0, abs = Math.abs(minor);
  const whole = new Intl.NumberFormat(LOCALE[currency] ?? "en-US").format(Math.trunc(abs / 100));
  const num = `${neg ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
  // built-in fonts have no rupee glyph: print the code instead of risking a wrong character
  const prefix = currency === "INR" && !unicode ? "INR " : (SYMBOL[currency] ?? currency + " ");
  return prefix + num;
}

export async function renderPdf(d: PdfData, o: PdfOptions = {}): Promise<Buffer> {
  const custom = Boolean(o.fontRegular && o.fontBold);
  const REG = custom ? "R" : "Helvetica", BOLD = custom ? "B" : "Helvetica-Bold";
  const t = (s: string | null | undefined) => {
    const x = (s ?? "").replace(/\t/g, " ").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
    return custom ? x : x.replace(/[^\u0020-\u007E\u00A0-\u00FF\u20AC\u2018-\u201D\u2013\u2014\u2022\n]/g, "?");
  };
  const money = (n: number) => formatMoney(n, d.currency, custom);
  const isInvoice = d.kind === "invoice";

  const doc = new PDFDocument({
    size: "A4", margin: M, bufferPages: true,
    info: { Title: `${isInvoice ? "Invoice" : "Quotation"} ${d.number ?? "DRAFT"}`, Author: t(d.seller.name), Producer: "Modulo" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on("end", () => res(Buffer.concat(chunks))); doc.on("error", rej); });
  if (custom) { doc.registerFont("R", o.fontRegular!); doc.registerFont("B", o.fontBold!); }

  // ---- header: seller (left), title + meta (right)
  doc.font(BOLD).fontSize(16).fillColor(INK).text(t(d.seller.name), M, M, { width: 270 });
  doc.font(REG).fontSize(9).fillColor(GRAY);
  const sellerLines = [...d.seller.lines, d.seller.taxId ? `Tax ID: ${d.seller.taxId}` : "", [d.seller.email, d.seller.phone].filter(Boolean).join("  |  ")].filter(Boolean);
  for (const l of sellerLines) doc.text(t(l), M, doc.y + 1, { width: 270 });
  const leftBottom = doc.y;

  const rx = W - M - 230;
  doc.font(BOLD).fontSize(22).fillColor(INK).text(isInvoice ? "INVOICE" : "QUOTATION", rx, M, { width: 230, align: "right" });
  let my = M + 34;
  const meta = (label: string, value: string) => {
    doc.font(REG).fontSize(9).fillColor(GRAY).text(label, rx, my, { width: 90, lineBreak: false });
    doc.font(BOLD).fillColor(INK).text(t(value), rx + 90, my, { width: 140, align: "right", lineBreak: false });
    my += 14;
  };
  meta("Number", d.number ?? "Draft");
  if (!isInvoice && (d.version ?? 1) > 1) meta("Version", `v${d.version}`);
  meta(isInvoice ? "Issue date" : "Date", d.date);
  if (isInvoice && d.dueDate) meta("Due date", d.dueDate);
  if (!isInvoice && d.validUntil) meta("Valid until", d.validUntil);
  meta("Currency", d.currency);

  // ---- bill to
  let y = Math.max(leftBottom, my) + 26;
  doc.font(BOLD).fontSize(8).fillColor(GRAY).text(isInvoice ? "BILL TO" : "PREPARED FOR", M, y, { characterSpacing: 1 });
  doc.font(BOLD).fontSize(11).fillColor(INK).text(t(d.customer.name), M, doc.y + 3, { width: 300 });
  doc.font(REG).fontSize(9).fillColor(GRAY);
  const cust = [...d.customer.lines, d.customer.taxId ? `Tax ID: ${d.customer.taxId}` : "", d.attention ? `Attn: ${d.attention}` : ""].filter(Boolean);
  for (const l of cust) doc.text(t(l), M, doc.y + 1, { width: 300 });
  y = doc.y + 22;

  // ---- items table (header repeats on every page)
  const c = { n: 22, qty: 55, unit: 80, tax: 42, amt: 88 };
  const descW = CW - c.n - c.qty - c.unit - c.tax - c.amt;
  const X = { n: M, desc: M + c.n, qty: M + c.n + descW, unit: M + c.n + descW + c.qty, tax: M + c.n + descW + c.qty + c.unit, amt: M + c.n + descW + c.qty + c.unit + c.tax };
  const LIMIT = H - 70;
  const tableHead = () => {
    doc.rect(M, y, CW, 22).fill(FILL);
    doc.font(BOLD).fontSize(8).fillColor(INK);
    doc.text("#", X.n + 4, y + 7, { width: c.n - 4, lineBreak: false });
    doc.text("DESCRIPTION", X.desc, y + 7, { width: descW, lineBreak: false });
    doc.text("QTY", X.qty, y + 7, { width: c.qty - 6, align: "right", lineBreak: false });
    doc.text("UNIT PRICE", X.unit, y + 7, { width: c.unit - 6, align: "right", lineBreak: false });
    doc.text("TAX", X.tax, y + 7, { width: c.tax - 6, align: "right", lineBreak: false });
    doc.text("AMOUNT", X.amt, y + 7, { width: c.amt - 4, align: "right", lineBreak: false });
    y += 22;
  };
  tableHead();
  d.items.forEach((it, i) => {
    doc.font(REG).fontSize(9.5);
    const h = Math.max(doc.heightOfString(t(it.description), { width: descW - 8 }), 12) + 12;
    if (y + h > LIMIT) { doc.addPage(); y = M; tableHead(); }
    doc.fillColor(GRAY).text(String(i + 1), X.n + 4, y + 6, { width: c.n - 4, lineBreak: false });
    doc.fillColor(INK).text(t(it.description), X.desc, y + 6, { width: descW - 8 });
    doc.text(String(Number(it.qty)), X.qty, y + 6, { width: c.qty - 6, align: "right", lineBreak: false });
    doc.text(money(it.unitMinor), X.unit, y + 6, { width: c.unit - 6, align: "right", lineBreak: false });
    doc.fillColor(GRAY).text(`${it.taxBps / 100}%`, X.tax, y + 6, { width: c.tax - 6, align: "right", lineBreak: false });
    doc.fillColor(INK).text(money(it.netMinor), X.amt, y + 6, { width: c.amt - 4, align: "right", lineBreak: false });
    y += h;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor(LINE).stroke();
  });

  // ---- totals (right aligned block)
  const byRate = new Map<number, number>();
  for (const it of d.items) if (it.taxMinor > 0 || it.taxBps > 0) byRate.set(it.taxBps, (byRate.get(it.taxBps) ?? 0) + it.taxMinor);
  const rows: [string, string, boolean][] = [["Subtotal", money(d.subtotalMinor), false]];
  for (const [bps, amt] of [...byRate].sort((a, b) => a[0] - b[0])) rows.push([`Tax ${bps / 100}%`, money(amt), false]);
  rows.push(["Total", money(d.totalMinor), true]);
  if (isInvoice) { rows.push(["Amount paid", money(d.paidMinor ?? 0), false]); rows.push(["Balance due", money(d.balanceMinor ?? d.totalMinor), true]); }
  if (y + rows.length * 20 + 20 > LIMIT) { doc.addPage(); y = M; }
  y += 14;
  const tx = W - M - 240;
  for (const [label, value, strong] of rows) {
    if (strong) doc.moveTo(tx, y - 3).lineTo(W - M, y - 3).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font(strong ? BOLD : REG).fontSize(strong ? 11 : 9.5).fillColor(strong ? INK : GRAY).text(label, tx, y, { width: 110, lineBreak: false });
    doc.fillColor(INK).text(value, tx + 110, y, { width: 130, align: "right", lineBreak: false });
    y += strong ? 22 : 17;
  }

  // ---- notes
  const note = (title: string, body: string | null | undefined) => {
    if (!body?.trim()) return;
    doc.font(REG).fontSize(9);
    const h = doc.heightOfString(t(body), { width: CW }) + 26;
    if (y + h > LIMIT) { doc.addPage(); y = M; }
    doc.font(BOLD).fontSize(8).fillColor(GRAY).text(title, M, y, { characterSpacing: 1, lineBreak: false });
    doc.font(REG).fontSize(9).fillColor(INK).text(t(body), M, y + 13, { width: CW });
    y = doc.y + 14;
  };
  y += 10;
  if (isInvoice) note("PAYMENT INSTRUCTIONS", d.seller.paymentInstructions);
  note(isInvoice ? "NOTES" : "TERMS", d.seller.footerNote);

  // ---- every page: stamp + footer
  const range = doc.bufferedPageRange();
  const stamp = STAMPS[d.status];
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    if (stamp) {
      doc.save(); doc.rotate(-35, { origin: [W / 2, H / 2] });
      doc.font(BOLD).fontSize(stamp[0].length > 6 ? 70 : 100).fillColor(stamp[1]).opacity(0.08)
        .text(stamp[0], 0, H / 2 - 50, { width: W, align: "center", lineBreak: false });
      doc.restore();
    }
    doc.page.margins.bottom = 0; // otherwise text this low would force a new page
    doc.moveTo(M, H - 42).lineTo(W - M, H - 42).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font(REG).fontSize(8).fillColor(GRAY);
    doc.text(t(`${d.seller.name}  |  ${isInvoice ? "Invoice" : "Quotation"} ${d.number ?? "DRAFT"}`), M, H - 34, { width: CW - 80, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, W - M - 80, H - 34, { width: 80, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}
