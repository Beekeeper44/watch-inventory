// Watch Inventory sign-in: GET = who am I, POST {action:'login'|'logout'|'change_password'}.
import { db, currentUser, checkPassword, hashPassword, setSession, clearSession, clean, parseBody } from './_lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = await db();
    if (req.method === 'GET') {
      const me = await currentUser(req, sql);
      return res.status(me ? 200 : 401).json({ user: me });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET or POST' }); }
    const b = parseBody(req);

    if (b.action === 'logout') { clearSession(res); return res.status(200).json({ ok: true }); }

    if (b.action === 'login') {
      const email = clean(b.email, 160).toLowerCase(), pw = String(b.password || '');
      const r = await sql`SELECT name, email, role, active, password_hash FROM watch_users WHERE lower(email) = ${email}`;
      if (!r.length || !checkPassword(pw, r[0].password_hash)) {
        await new Promise(ok => setTimeout(ok, 400));   // slow down guessing
        return res.status(401).json({ error: 'Wrong email or password' });
      }
      if (!r[0].active) return res.status(403).json({ error: 'Your access is turned off — ask an admin' });
      setSession(res, email);
      return res.status(200).json({ user: { name: r[0].name, email, role: r[0].role } });
    }

    if (b.action === 'change_password') {
      const me = await currentUser(req, sql);
      if (!me) return res.status(401).json({ error: 'Please sign in' });
      const r = await sql`SELECT password_hash FROM watch_users WHERE lower(email) = ${me.email}`;
      if (!checkPassword(String(b.current || ''), r[0] && r[0].password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
      const next = String(b.next || '');
      if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      await sql`UPDATE watch_users SET password_hash = ${hashPassword(next)} WHERE lower(email) = ${me.email}`;
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
