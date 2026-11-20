// Watch Inventory: Vendor and Sold Price typed into the "Totals by" table, shared through Neon.
// Neon stores only these two columns per row (with who last edited them), the vendor name list, the user list, and each user's column choices.
// Env: DATABASE_URL (set automatically by Vercel's Neon integration; POSTGRES_URL also works).
import { neon } from '@neondatabase/serverless';

let ready = null;
function db() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('Set DATABASE_URL (Neon) in Vercel');
  const sql = neon(url);
  if (!ready) ready = sql`CREATE TABLE IF NOT EXISTS watch_group_fills (
      tab text NOT NULL, group_col text NOT NULL, group_value text NOT NULL,
      vendor text, sold_price numeric(12,2),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tab, group_col, group_value))`
    .then(() => sql`ALTER TABLE watch_group_fills ADD COLUMN IF NOT EXISTS updated_by text`)
    .then(() => sql`CREATE TABLE IF NOT EXISTS watch_vendors (name text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`)
    .then(() => sql`CREATE TABLE IF NOT EXISTS watch_users (name text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`)
    .then(() => sql`CREATE TABLE IF NOT EXISTS watch_user_prefs (name text PRIMARY KEY, prefs jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())`)
    .catch(e => { ready = null; throw e; });
  return ready.then(() => sql);
}
const clean = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = await db();
    if (req.method === 'GET') {
      const [rows, vendors, users, prefs] = await Promise.all([
        sql`SELECT tab, group_col, group_value, vendor, sold_price::float8 AS sold_price, updated_at, updated_by FROM watch_group_fills`,
        sql`SELECT name FROM watch_vendors ORDER BY lower(name)`,
        sql`SELECT name FROM watch_users ORDER BY lower(name)`,
        sql`SELECT name, prefs FROM watch_user_prefs`
      ]);
      return res.status(200).json({ rows, vendors: vendors.map(v => v.name), users: users.map(u => u.name), prefs });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET or POST' }); }

    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }

    // users
    if (b.action === 'add_user' || b.action === 'remove_user') {
      const name = clean(b.name, 80);
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (b.action === 'add_user') await sql`INSERT INTO watch_users (name) VALUES (${name}) ON CONFLICT (name) DO NOTHING`;
      else await sql`DELETE FROM watch_users WHERE name = ${name}`;
      const users = await sql`SELECT name FROM watch_users ORDER BY lower(name)`;
      return res.status(200).json({ ok: true, users: users.map(u => u.name) });
    }

    // per-user settings (e.g. which table columns show)
    if (b.action === 'save_prefs') {
      const name = clean(b.name, 80);
      if (!name || !b.prefs || typeof b.prefs !== 'object') return res.status(400).json({ error: 'name and prefs are required' });
      const json = JSON.stringify(b.prefs);
      if (json.length > 20000) return res.status(400).json({ error: 'Settings too large' });
      await sql`INSERT INTO watch_user_prefs (name, prefs) VALUES (${name}, ${json}::jsonb)
        ON CONFLICT (name) DO UPDATE SET prefs = watch_user_prefs.prefs || EXCLUDED.prefs, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }

    // vendor / sold price
    const tab = clean(b.tab, 20), col = clean(b.group_col, 120), val = (b.group_value == null ? '' : String(b.group_value)).slice(0, 500);
    const by = clean(b.user, 80) || null;
    if (!['warehouse', 'retrieved', 'all'].includes(tab) || !col) return res.status(400).json({ error: 'tab and group_col are required' });

    if (b.field === 'vendor') {
      const v = clean(b.value, 200) || null;
      await sql`INSERT INTO watch_group_fills (tab, group_col, group_value, vendor, updated_by) VALUES (${tab}, ${col}, ${val}, ${v}, ${by})
        ON CONFLICT (tab, group_col, group_value) DO UPDATE SET vendor = EXCLUDED.vendor, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      if (v) await sql`INSERT INTO watch_vendors (name) VALUES (${v}) ON CONFLICT (name) DO NOTHING`;
    } else if (b.field === 'sold_price') {
      const n = b.value == null || b.value === '' ? null : Number(b.value);
      if (n != null && !Number.isFinite(n)) return res.status(400).json({ error: 'Sold price must be a number' });
      await sql`INSERT INTO watch_group_fills (tab, group_col, group_value, sold_price, updated_by) VALUES (${tab}, ${col}, ${val}, ${n}, ${by})
        ON CONFLICT (tab, group_col, group_value) DO UPDATE SET sold_price = EXCLUDED.sold_price, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    } else return res.status(400).json({ error: 'field must be vendor or sold_price' });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
