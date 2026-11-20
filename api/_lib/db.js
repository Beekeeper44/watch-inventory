// Shared by the API routes: Neon connection, tables, seeded users, passwords and sign-in sessions.
// Env: DATABASE_URL (Neon). Optional: SESSION_SECRET (otherwise derived from your existing secrets), ADMIN_EMAILS.
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

let ready = null;
export function db() {
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
    .then(() => sql`ALTER TABLE watch_users ADD COLUMN IF NOT EXISTS password_hash text`)
    .then(() => sql`CREATE TABLE IF NOT EXISTS watch_meta (key text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`)
    .then(() => seedAdmins(sql))
    .then(() => seedMembers(sql))
    .then(() => seedPasswords(sql))
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
export const USERS_SQL = sql => sql`SELECT name, email, role, active FROM watch_users ORDER BY role = 'admin' DESC, active DESC, lower(name)`;

// ---------- passwords ----------
// Default password = first name in lower case + 123 (e.g. Alan Bailey → alan123). The first letter may be typed in capitals.
export const defaultPassword = name => (String(name || '').trim().split(/\s+/)[0] || 'user').toLowerCase().replace(/[^a-z0-9]/g, '') + '123';
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function matches(pw, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const t = crypto.scryptSync(String(pw), salt, 32);
  const s = Buffer.from(h, 'hex');
  return s.length === t.length && crypto.timingSafeEqual(s, t);
}
export const checkPassword = (pw, stored) => matches(pw, stored) || matches(String(pw).charAt(0).toLowerCase() + String(pw).slice(1), stored);
async function seedPasswords(sql) {
  const missing = await sql`SELECT name, email FROM watch_users WHERE password_hash IS NULL AND email IS NOT NULL`;
  for (const u of missing) await sql`UPDATE watch_users SET password_hash = ${hashPassword(defaultPassword(u.name))} WHERE lower(email) = ${u.email.toLowerCase()}`;
}

// ---------- sessions (signed cookie, 14 days) ----------
const COOKIE = 'wi_session', DAYS = 14;
const secret = () => process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('watch-inventory:' + (process.env.DATABASE_URL || process.env.POSTGRES_URL || '') + (process.env.METABASE_API_KEY || '')).digest('hex');
const mac = s => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
export function setSession(res, email) {
  const body = Buffer.from(JSON.stringify({ e: email, x: Date.now() + DAYS * 864e5 })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${body}.${mac(body)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`);
}
export const clearSession = res => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
function sessionEmail(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !sig) return null;
  const want = mac(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); return d.x > Date.now() ? String(d.e).toLowerCase() : null; } catch { return null; }
}
// The signed-in, active user, or null.
export async function currentUser(req, sql) {
  const email = sessionEmail(req);
  if (!email) return null;
  const r = await sql`SELECT name, email, role, active FROM watch_users WHERE lower(email) = ${email}`;
  return r.length && r[0].active ? { name: r[0].name, email: r[0].email.toLowerCase(), role: r[0].role } : null;
}
export const clean = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
export const parseBody = req => { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } return b || {}; };
