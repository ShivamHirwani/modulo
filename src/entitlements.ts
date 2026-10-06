import type { PoolClient } from "pg";

// Make tenant_modules match exactly `ids`: enable listed, disable the rest.
export async function syncModules(c: PoolClient, tenantId: string, ids: string[]) {
  for (const id of ids)
    await c.query(
      `INSERT INTO tenant_modules (tenant_id, module_id) VALUES ($1,$2)
       ON CONFLICT (tenant_id, module_id) DO UPDATE SET disabled_at = NULL, enabled_at = CASE WHEN tenant_modules.disabled_at IS NULL THEN tenant_modules.enabled_at ELSE now() END`, [tenantId, id]);
  await c.query("UPDATE tenant_modules SET disabled_at = now() WHERE disabled_at IS NULL AND NOT (module_id = ANY($1::text[]))", [ids]);
}
