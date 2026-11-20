// Watch Inventory: Vendor and Sold Price typed into the "Totals by" table, plus users and per-user settings, in Neon.
// Every request needs a signed-in user (see api/auth.js); edits are recorded under that user's email.
import { db, USERS_SQL, currentUser, hashPassword, defaultPassword, clean, parseBody } from './_lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = await db();
    const me = await currentUser(req, sql);
    if (!me) return res.status(401).json({ error: 'Please sign in' });
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

    const b = parseBody(req);

    // users
    // users are identified by email; the name is how they're shown
    if (['add_user', 'remove_user', 'set_role', 'set_active', 'reset_password'].includes(b.action)) {
      // only an admin can change the user list
      const actor = me.email;
      if (me.role !== 'admin') return res.status(403).json({ error: 'Only an admin can add, remove or change users' });
      const email = clean(b.email, 160).toLowerCase();
      if (b.action === 'reset_password') {
        const u = await sql`SELECT name FROM watch_users WHERE lower(email) = ${email}`;
        if (!u.length) return res.status(404).json({ error: 'No such user' });
        const pw = clean(b.password, 100) || defaultPassword(u[0].name);
        if (pw.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
        await sql`UPDATE watch_users SET password_hash = ${hashPassword(pw)} WHERE lower(email) = ${email}`;
        return res.status(200).json({ ok: true, password: pw });
      }
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
        const pw = clean(b.password, 100) || defaultPassword(name);
        if (pw.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
        const hash = hashPassword(pw);
        const taken = await sql`SELECT name FROM watch_users WHERE lower(email) = ${email}`;
        if (taken.length) await sql`UPDATE watch_users SET name = ${name}, password_hash = COALESCE(password_hash, ${hash}) WHERE lower(email) = ${email}`;
        else {
          const clash = await sql`SELECT 1 FROM watch_users WHERE name = ${name}`;
          if (clash.length) await sql`UPDATE watch_users SET email = ${email}, password_hash = ${hash} WHERE name = ${name} AND email IS NULL`;
          else await sql`INSERT INTO watch_users (name, email, password_hash) VALUES (${name}, ${email}, ${hash})`;
        }
        return res.status(200).json({ ok: true, users: await USERS_SQL(sql), password: pw });
      } else {
        if (email) await sql`DELETE FROM watch_users WHERE lower(email) = ${email}`;
        else await sql`DELETE FROM watch_users WHERE name = ${clean(b.name, 80)} AND email IS NULL`;
      }
      const users = await USERS_SQL(sql);
      return res.status(200).json({ ok: true, users });
    }

    // per-user settings (e.g. which table columns show)
    if (b.action === 'save_prefs') {
      const name = me.email;
      if (!b.prefs || typeof b.prefs !== 'object') return res.status(400).json({ error: 'name and prefs are required' });
      const json = JSON.stringify(b.prefs);
      if (json.length > 20000) return res.status(400).json({ error: 'Settings too large' });
      await sql`INSERT INTO watch_user_prefs (name, prefs) VALUES (${name}, ${json}::jsonb)
        ON CONFLICT (name) DO UPDATE SET prefs = watch_user_prefs.prefs || EXCLUDED.prefs, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }

    // vendor / sold price
    const tab = clean(b.tab, 20), col = clean(b.group_col, 120), val = (b.group_value == null ? '' : String(b.group_value)).slice(0, 500);
    const by = me.email;
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
