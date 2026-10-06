import pg from "pg";
import type { PoolClient } from "pg";
import type { ModuleDef, Currency } from "./pricing.ts";

// bigint (20) and numeric (1700) default to strings; our caps keep money well under 2^53.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v); // date -> 'YYYY-MM-DD', no timezone shifting

export const createPool = (url: string, max = 10) => new pg.Pool({ connectionString: url, max });
export type Pool = pg.Pool;

// Every tenant query runs inside this: transaction + app.tenant_id set LOCAL => Postgres RLS enforces isolation.
export async function withTenant<T>(pool: Pool, tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Catalog straight from DB (versioned prices: only the row valid now).
export async function loadCatalog(pool: Pool): Promise<ModuleDef[]> {
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.launched, p.currency, p.monthly_minor
       FROM modules m
       LEFT JOIN module_prices p ON p.module_id = m.id AND p.valid_from <= now() AND (p.valid_to IS NULL OR p.valid_to > now())
      ORDER BY m.sort_order`,
  );
  const map = new Map<string, ModuleDef>();
  for (const r of rows) {
    const m = map.get(r.id) ?? { id: r.id, name: r.name, launched: r.launched, price: {} as Record<Currency, number> };
    if (r.currency) m.price[r.currency as Currency] = r.monthly_minor;
    map.set(r.id, m);
  }
  return [...map.values()];
}
