// Modulo pricing engine. Pure functions, integer minor units (cents/paise). No floats for money.
// Server is the ONLY source of truth for price. Never trust the browser total.

export type Currency = "USD" | "INR" | "EUR";
export type Billing = "monthly" | "annual";

export interface ModuleDef {
  id: string;
  name: string;
  launched: boolean; // false = coming soon, cannot be bought
  price: Record<Currency, number>; // per month, minor units
}

export interface Rules {
  seatPrice: Record<Currency, number>; // per user per month
  minSeats: number;
  maxSeats: number; // above this -> enterprise quote
  bundleTiers: { minModules: number; pct: number }[]; // pct in basis points (500 = 5%)
  seatTiers: { minSeats: number; pct: number }[];
  annualPct: number; // basis points
}

export const DEFAULT_RULES: Rules = {
  seatPrice: { USD: 600, INR: 52800, EUR: 550 },
  minSeats: 1,
  maxSeats: 300,
  bundleTiers: [
    { minModules: 9, pct: 1500 },
    { minModules: 6, pct: 1000 },
    { minModules: 3, pct: 500 },
  ],
  seatTiers: [
    { minSeats: 100, pct: 2000 },
    { minSeats: 25, pct: 1000 },
  ],
  annualPct: 2000,
};

export const LAUNCH_CATALOG: ModuleDef[] = [
  { id: "quote", name: "Quotation System", launched: true, price: { USD: 1200, INR: 105600, EUR: 1100 } },
  { id: "bill", name: "Billing & Invoicing", launched: true, price: { USD: 1800, INR: 158400, EUR: 1650 } },
  { id: "assets", name: "Asset Management", launched: true, price: { USD: 1500, INR: 132000, EUR: 1380 } },
  { id: "dept", name: "Department Management", launched: true, price: { USD: 1200, INR: 105600, EUR: 1100 } },
];

export interface PriceInput {
  moduleIds: string[];
  seats: number;
  billing: Billing;
  currency: Currency;
}

export interface Line {
  code: string;
  label: string;
  amount: number; // minor units, negative for discounts
}

export interface Quote {
  currency: Currency;
  billing: Billing;
  lines: Line[];
  monthlyTotal: number; // what customer pays per month (after annual discount)
  periodTotal: number; // what is charged per billing cycle (x12 if annual)
}

export class PricingError extends Error {
  code: "UNKNOWN_MODULE" | "NOT_LAUNCHED" | "BAD_SEATS" | "ENTERPRISE_REQUIRED" | "NO_PRICE";
  constructor(code: PricingError["code"], msg: string) {
    super(msg);
    this.code = code;
  }
}

// integer percent helper, rounds half up
const pct = (amount: number, bps: number) => Math.floor((amount * bps + 5000) / 10000);

const best = <T extends { pct: number }>(tiers: T[], ok: (t: T) => boolean) =>
  tiers.filter(ok).reduce((m, t) => Math.max(m, t.pct), 0);

export function price(input: PriceInput, catalog: ModuleDef[] = LAUNCH_CATALOG, rules: Rules = DEFAULT_RULES): Quote {
  const { currency, billing } = input;
  const ids = [...new Set(input.moduleIds)]; // dedupe

  if (!Number.isInteger(input.seats) || input.seats < rules.minSeats)
    throw new PricingError("BAD_SEATS", "seats must be a whole number >= " + rules.minSeats);
  if (input.seats > rules.maxSeats)
    throw new PricingError("ENTERPRISE_REQUIRED", `more than ${rules.maxSeats} seats needs an enterprise quote`);

  const lines: Line[] = [];
  let modulesSum = 0;

  for (const id of ids) {
    const m = catalog.find((c) => c.id === id);
    if (!m) throw new PricingError("UNKNOWN_MODULE", `unknown module: ${id}`);
    if (!m.launched) throw new PricingError("NOT_LAUNCHED", `module not available yet: ${id}`);
    const p = m.price[currency];
    if (p == null) throw new PricingError("NO_PRICE", `no ${currency} price for ${id}`);
    modulesSum += p;
    lines.push({ code: `module:${id}`, label: m.name, amount: p });
  }

  const seatsSum = input.seats * rules.seatPrice[currency];
  lines.unshift({ code: "seats", label: `${input.seats} user(s)`, amount: seatsSum });

  const bundleBps = best(rules.bundleTiers.map((t) => ({ ...t })), (t) => ids.length >= t.minModules);
  const seatBps = best(rules.seatTiers.map((t) => ({ ...t })), (t) => input.seats >= t.minSeats);

  let subtotal = modulesSum + seatsSum;
  if (bundleBps) {
    const d = pct(modulesSum, bundleBps);
    subtotal -= d;
    lines.push({ code: "discount:bundle", label: `Bundle discount (${bundleBps / 100}%)`, amount: -d });
  }
  if (seatBps) {
    const d = pct(seatsSum, seatBps);
    subtotal -= d;
    lines.push({ code: "discount:volume", label: `Volume discount (${seatBps / 100}%)`, amount: -d });
  }
  if (billing === "annual") {
    const d = pct(subtotal, rules.annualPct);
    subtotal -= d;
    lines.push({ code: "discount:annual", label: `Annual billing (${rules.annualPct / 100}%)`, amount: -d });
  }

  return {
    currency,
    billing,
    lines,
    monthlyTotal: subtotal,
    periodTotal: billing === "annual" ? subtotal * 12 : subtotal,
  };
}

// Mid-cycle change: charge/credit difference for remaining days only.
export function prorate(oldPeriodTotal: number, newPeriodTotal: number, daysLeft: number, daysInPeriod: number): number {
  if (daysInPeriod <= 0 || daysLeft < 0 || daysLeft > daysInPeriod) throw new RangeError("bad day counts");
  return Math.round(((newPeriodTotal - oldPeriodTotal) * daysLeft) / daysInPeriod);
}
