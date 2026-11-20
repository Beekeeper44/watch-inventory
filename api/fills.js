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
    .then(() => sql`ALTER TABLE watch_users ADD COLUMN IF NOT EXISTS email text`)
    .then(() => sql`CREATE UNIQUE INDEX IF NOT EXISTS watch_users_email_key ON watch_users (lower(email)) WHERE email IS NOT NULL`)
    .then(() => sql`ALTER TABLE watch_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'`)
    .then(() => sql`ALTER TABLE watch_users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`)
    .then(() => sql`CREATE TABLE IF NOT EXISTS watch_meta (key text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`)
    .then(() => seedAdmins(sql))
    .then(() => seedMembers(sql))
    .then(() => sql`CREATE TABLE IF NOT EXISTS watch_user_prefs (name text PRIMARY KEY, prefs jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())`)
    .catch(e => { ready = null; throw e; });
  return ready.then(() => sql);
}
// Admins come from ADMIN_EMAILS (comma separated); Alan is the default admin.
const ADMINS = (process.env.ADMIN_EMAILS || 'alan@arenaclub.com:Alan Bailey').split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const [email, name] = s.split(':'); return { email: email.toLowerCase(), name: (name || email.split('@')[0]).trim() }; });
async function seedAdmins(sql) {
  for (const a of ADMINS) {
    const hit = await sql`UPDATE watch_users SET role = 'admin' WHERE lower(email) = ${a.email} RETURNING name`;
    if (hit.length) continue;
    const byName = await sql`UPDATE watch_users SET role = 'admin', email = ${a.email} WHERE name = ${a.name} AND email IS NULL RETURNING name`;
    if (!byName.length) await sql`INSERT INTO watch_users (name, email, role) VALUES (${a.name}, ${a.email}, 'admin') ON CONFLICT (name) DO UPDATE SET role = 'admin'`;
  }
}
// Members, added once per batch (after that the admin manages the list in the app).
// To add more later, append a new batch with a new key.
const MEMBER_BATCHES = [
  { key: 'seed_members_v1', members: [
    { name: 'Beatriz Garay', email: 'bgaray@arenaclub.com' },
    { name: 'Brock Kounalis', email: 'bkounalis@arenaclub.com' }
  ] },
  { key: 'seed_members_v2', members: [
    { name: 'Nick Hartley', email: 'nhartley@arenaclub.com' },
    { name: 'David Brockway', email: 'dbrockway@arenaclub.com' },
    { name: 'Michelle Laddon', email: 'mladdon@arenaclub.com' }
  ] },
  { key: 'seed_members_v3', members: [
    { name: 'Kye Labit', email: 'klabit@arenaclub.com' }
  ] }
];
async function seedMembers(sql) {
  for (const batch of MEMBER_BATCHES) {
    const done = await sql`SELECT 1 FROM watch_meta WHERE key = ${batch.key}`;
    if (done.length) continue;
    for (const m of batch.members) {
      const have = await sql`SELECT 1 FROM watch_users WHERE lower(email) = ${m.email}`;
      if (!have.length) await sql`INSERT INTO watch_users (name, email, role) VALUES (${m.name}, ${m.email}, 'user') ON CONFLICT (name) DO UPDATE SET email = COALESCE(watch_users.email, EXCLUDED.email)`;
    }
    await sql`INSERT INTO watch_meta (key) VALUES (${batch.key}) ON CONFLICT DO NOTHING`;
  }
}
const USERS_SQL = sql => sql`SELECT name, email, role, active FROM watch_users ORDER BY role = 'admin' DESC, active DESC, lower(name)`;
async function activeUser(sql, email) {
  if (!email) return true;   // older edits without a user still save
  const r = await sql`SELECT active FROM watch_users WHERE lower(email) = ${email} OR name = ${email}`;
  return !r.length || r[0].active;
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
        USERS_SQL(sql),
        sql`SELECT name, prefs FROM watch_user_prefs`
      ]);
      return res.status(200).json({ rows, vendors: vendors.map(v => v.name), users, prefs });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET or POST' }); }

    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }

    // users
    // users are identified by email; the name is how they're shown
    if (b.action === 'add_user' || b.action === 'remove_user' || b.action === 'set_role' || b.action === 'set_active') {
      // only an admin can change the user list
      const actor = clean(b.actor, 160).toLowerCase();
      const isAdmin = actor && (await sql`SELECT 1 FROM watch_users WHERE lower(email) = ${actor} AND role = 'admin' AND active`).length;
      if (!isAdmin) return res.status(403).json({ error: 'Only an admin can add, remove or change users' });
      const email = clean(b.email, 160).toLowerCase();
      if (b.action === 'set_active') {
        if (email === actor) return res.status(400).json({ error: "You can't turn off your own access" });
        await sql`UPDATE watch_users SET active = ${!!b.active} WHERE lower(email) = ${email}`;
        return res.status(200).json({ ok: true, users: await USERS_SQL(sql) });
      }
      if (b.action === 'set_role') {
        const role = b.role === 'admin' ? 'admin' : 'user';
        if (role === 'user') {
          const admins = await sql`SELECT count(*)::int AS n FROM watch_users WHERE role = 'admin'`;
          if (admins[0].n <= 1) return res.status(400).json({ error: 'There must be at least one admin' });
        }
        await sql`UPDATE watch_users SET role = ${role} WHERE lower(email) = ${email}`;
        const users = await USERS_SQL(sql);
        return res.status(200).json({ ok: true, users });
      }
      if (b.action === 'remove_user' && email === actor) return res.status(400).json({ error: "You can't remove yourself" });
      if (b.action === 'add_user') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
        const name = clean(b.name, 80) || email.split('@')[0];
        const taken = await sql`SELECT name FROM watch_users WHERE lower(email) = ${email}`;
        if (taken.length) await sql`UPDATE watch_users SET name = ${name} WHERE lower(email) = ${email}`;
        else {
          const clash = await sql`SELECT 1 FROM watch_users WHERE name = ${name}`;
          if (clash.length) await sql`UPDATE watch_users SET email = ${email} WHERE name = ${name} AND email IS NULL`;
          else await sql`INSERT INTO watch_users (name, email) VALUES (${name}, ${email})`;
        }
      } else {
        if (email) await sql`DELETE FROM watch_users WHERE lower(email) = ${email}`;
        else await sql`DELETE FROM watch_users WHERE name = ${clean(b.name, 80)} AND email IS NULL`;
      }
      const users = await USERS_SQL(sql);
      return res.status(200).json({ ok: true, users });
    }

    // per-user settings (e.g. which table columns show)
    if (b.action === 'save_prefs') {
      if (!(await activeUser(sql, clean(b.name, 160).toLowerCase()))) return res.status(403).json({ error: 'Your access is turned off' });
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
    const by = clean(b.user, 160) || null;
    if (!(await activeUser(sql, (by || '').toLowerCase()))) return res.status(403).json({ error: 'Your access is turned off' });
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
