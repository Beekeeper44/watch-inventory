// Watch Inventory: Metabase proxy for the warehouse (31879) and retrieved items (47950) questions.
// Env: METABASE_HOST, METABASE_API_KEY, optional WAREHOUSE_CARD_ID (or WATCH_CARD_ID) and RETRIEVED_CARD_ID.
// Only signed-in, active users get data (see api/auth.js).
// Uses the JSON export endpoint so results aren't capped at Metabase's 2,000-row /query limit.
// Reads the question's own filters (template tags) and only sends the ones it has.

import { db, currentUser } from './_lib/db.js';
import zlib from 'node:zlib';

// big result sets: allow up to 60s (Vercel caps this to your plan's maximum)
export const config = { maxDuration: 60 };

const SYNONYMS = {
  reference_number: ['reference_number', 'reference', 'ref', 'watch_reference', 'ref_number'],
  ac_number: ['ac_number', 'ac', 'item_number', 'number'],
  po_number: ['po_number', 'po', 'purchase_order', 'purchase_order_number'],
  order_number: ['order_number', 'order', 'order_id'],
  model: ['model', 'model_name'],
  brand: ['brand', 'brand_name']
};
const normKey = k => String(k).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const meta = {}; // per-card cache: { name, tags: {tagName: tagDef}, at }

async function cardMeta(host, key, card) {
  const m = meta[card];
  if (m && Date.now() - m.at < 10 * 60 * 1000) return m;
  try {
    const r = await fetch(`${host}/api/card/${card}`, { headers: { 'x-api-key': key } });
    const j = await r.json();
    const dq = j.dataset_query || {};
    const tags = (dq.native && dq.native['template-tags']) || (dq.stages && dq.stages[0] && dq.stages[0]['template-tags']) || {};
    return (meta[card] = { name: j.name || `Question ${card}`, tags, dq, cols: j.result_metadata || [], at: Date.now() });
  } catch {
    return { name: `Question ${card}`, tags: {}, at: 0 };
  }
}

function mapTags(tags) {
  // client key -> real tag name on this question
  const lower = Object.fromEntries(Object.keys(tags).map(t => [t.toLowerCase(), t]));
  const out = {};
  for (const [k, list] of Object.entries(SYNONYMS)) {
    const hit = list.find(s => lower[s]);
    if (hit) out[k] = lower[hit];
  }
  // looser: any filter whose name or label mentions "ref" (e.g. "Reference #" → reference_no)
  if (!out.reference_number) {
    const t = Object.keys(tags).find(t => {
      const label = `${t} ${(tags[t] && (tags[t]['display-name'] || tags[t].display_name)) || ''}`.toLowerCase();
      return /ref/.test(label) && !/order|po_|purchase|url/.test(label);
    });
    if (t) out.reference_number = t;
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const me = await currentUser(req, await db());
    if (!me) return res.status(401).json({ error: 'Please sign in' });
  } catch (e) {
    return res.status(500).json({ error: `Sign-in check failed: ${e.message}` });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST' }); }

  const host = (process.env.METABASE_HOST || '').replace(/\/+$/, '');
  const key = process.env.METABASE_API_KEY;
  let body0 = req.body;
  if (typeof body0 === 'string') { try { body0 = JSON.parse(body0); } catch { body0 = {}; } }
  // warehouse + retrieved are loaded in full; "lookup" is an all-items question (e.g. Items Search) used only
  // to find a reference that isn't in the other two — e.g. a watch that has already shipped
  // Sources: warehouse (48016), retrieved (47950), all (31879 — every item, also used by the
  // Image tab), lookup (= all, searched by Reference # for refs missing from the loaded rows)
  const src = body0 && body0.source;
  const source = ['warehouse', 'retrieved', 'all', 'lookup'].includes(src) ? src : 'warehouse';
  const ALL = process.env.ALL_CARD_ID || '31879';
  const card = source === 'retrieved' ? (process.env.RETRIEVED_CARD_ID || '47950')
    : source === 'all' ? ALL
    : source === 'lookup' ? (process.env.LOOKUP_CARD_ID || ALL)
    : (process.env.WAREHOUSE_CARD_ID || '48016');
  if (!host || !key) return res.status(500).json({ error: 'Set METABASE_HOST and METABASE_API_KEY in Vercel' });
  if (!card) return res.status(400).json({ error: 'Warehouse question not set yet (WAREHOUSE_CARD_ID)', code: 'no_card', source });

  const params = (body0 && body0.params) || {};
  // several references in one go: ["16618", "126610LN", …]
  const refList = Array.isArray(params.reference_numbers) ? params.reference_numbers.map(v => String(v).trim()).filter(Boolean).slice(0, 200) : null;
  if (refList) { delete params.reference_numbers; if (refList.length === 1) params.reference_number = refList[0]; }

  const { name, tags } = await cardMeta(host, key, card);
  const tagMap = mapTags(tags);

  // build Metabase parameters from the question's own filter definitions (type + widget type), so they aren't rejected
  const parameters = Object.entries(params)
    .filter(([k, v]) => tagMap[k] && v != null && String(v).trim() !== '')
    .map(([k, v]) => {
      const t = tagMap[k], def = tags[t] || {}, value = String(v).trim();
      const widget = def['widget-type'] || def.widget_type;
      const asNum = /number/.test(widget || def.type || '') && !isNaN(+value);
      if (def.type === 'dimension') {
        const type = widget && widget !== 'none' ? widget : (asNum ? 'number/=' : 'string/=');
        return { type, target: ['dimension', ['template-tag', t]], value: [asNum ? +value : value] };
      }
      return { type: def.type === 'number' ? 'number/=' : 'category', target: ['variable', ['template-tag', t]], value: def.type === 'number' && !isNaN(+value) ? +value : value };
    });

  // gzip the JSON: thousands of watches stay well under Vercel's response-size limit
  const send = (cols, rows, via, note) => {
    const body = JSON.stringify({
      card, name, source, via, note: note || null, filters: Object.keys(tagMap), count: rows.length,
      truncated: via === 'query' && rows.length >= 2000, cols, rows
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip');
      return res.status(200).end(zlib.gzipSync(body));
    }
    return res.status(200).end(body);
  };
  const runDataset = async q => {
    const tries = [
      { headers: { 'x-api-key': key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ query: JSON.stringify(q), format_rows: 'false' }) },
      { headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, format_rows: false, pivot_results: false }) }
    ];
    let last = { status: 0, j: null };
    for (const t of tries) {
      const r = await fetch(`${host}/api/dataset/json`, { method: 'POST', ...t });
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
      if (r.ok && Array.isArray(j)) return { ok: true, j };
      last = { status: r.status, j };
    }
    return { ok: false, ...last };
  };
  const fromObjects = j => { const keys = j.length ? Object.keys(j[0]) : []; return [keys.map(normKey), j.map(o => keys.map(k => o[k]))]; };

  // 0) Every row: run the question's own query without its row cap (SQL "LIMIT 5000" / "FETCH FIRST n ROWS" /
  //    "TOP n", or a GUI question's row limit), as a full export. For GUI questions a Reference search is added as
  //    a real filter on the Reference column, so lookups work even without a {{reference}} variable.
  const meta0 = meta[card];
  const dq = meta0 && meta0.dq;
  let why = '';
  if (dq && dq.database) {
    try {
      const q = JSON.parse(JSON.stringify(dq));
      let changed = false;
      const dropLimit = obj => { if (obj && typeof obj === 'object') { if (obj.limit != null) { delete obj.limit; changed = true; } if (obj['source-query']) dropLimit(obj['source-query']); } };
      if (q.native && typeof q.native.query === 'string') {
        const s = q.native.query;
        const t = s
          .replace(/\blimit\s+\d{3,}(\s+offset\s+\d+)?/gi, ' ')                    // row caps (100+)
          .replace(/\bfetch\s+(first|next)\s+\d{3,}\s+rows?\s+only\b/gi, ' ')
          .replace(/\bselect\s+top\s+\d{3,}\b/gi, 'select ')
          .replace(/;\s*$/, '');
        if (t !== s) { q.native.query = t; changed = true; }
      }
      dropLimit(q.query);
      if (Array.isArray(q.stages)) q.stages.forEach(dropLimit);
      // GUI question + reference search → add the filter to the query itself
      let refFilter = false;
      const wanted = refList || (params.reference_number ? [String(params.reference_number).trim()] : null);
      if (q.query && wanted && (refList ? refList.length > 1 || !tagMap.reference_number : !tagMap.reference_number)) {
        const col = (meta0.cols || []).find(c => /^(reference|reference_number|ref|ref_number|reference_no)$/i.test(String(c.name || '').replace(/\W+/g, '_')) || /^reference/i.test(c.display_name || ''));
        if (col && col.field_ref) {
          const cond = ['=', col.field_ref, ...wanted];
          q.query.filter = q.query.filter ? ['and', q.query.filter, cond] : cond;
          changed = true; refFilter = true;
        }
      }
      if (changed || wanted) {
        q.parameters = parameters;
        let ds = await runDataset(q);
        let j = ds.ok ? ds.j : null;
        let localFilter = false;
        // the question rejected our filter value: run it unfiltered and filter the references here instead
        if (!Array.isArray(j) && wanted && parameters.length) {
          q.parameters = [];
          ds = await runDataset(q);
          if (ds.ok){ j = ds.j; localFilter = true; }
        }
        if (Array.isArray(j)) {
          let [cols, rows] = fromObjects(j);
          // native question with no reference variable: filter the full result here instead
          if (wanted && !refFilter && (localFilter || (refList ? refList.length > 1 || !tagMap.reference_number : !tagMap.reference_number))) {
            const nz = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const want = new Set(wanted.map(nz));
            const idx = cols.map((c, i) => /^(REFERENCE|REFERENCE_NUMBER|REF|REF_NUMBER|REFERENCE_NO)$/.test(c) ? i : -1).filter(i => i >= 0);
            rows = rows.filter(row => idx.some(i => want.has(nz(row[i]))));
          }
          return send(cols, rows, 'export-all');
        }
        why = `Metabase won't run it without the limit (${ds.status}${ds.j && (ds.j.error || ds.j.message) ? ': ' + String(ds.j.error || ds.j.message).slice(0, 120) : ''}) — remove the row limit in the question, or give the API key native query access`;
      } else why = 'no row limit found in the question';
    } catch (e) { why = `full export failed: ${e.message}`; }
  }

  // 1) Full export of the saved question (no 2,000 cap, but keeps any LIMIT written into the question)
  try {
    const r = await fetch(`${host}/api/card/${card}/query/json`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: 'false' })
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j)) { const [cols, rows] = fromObjects(j); return send(cols, rows, 'export', why); }
      if (j && j.error) throw new Error(j.error);
    }
  } catch (e) {
    if (/template|parameter|variable/i.test(e.message)) return res.status(400).json({ error: e.message, card, source });
  }

  // 2) Fallback: standard query (capped at 2,000 rows)
  try {
    const r = await fetch(`${host}/api/card/${card}/query`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameters })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || !j.data) return res.status(502).json({ error: String(j.error || j.message || `Metabase returned ${r.status}`), card, source });
    return send(j.data.cols.map(c => normKey(c.name || c.display_name)), j.data.rows, 'query', why);
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Metabase: ${e.message}`, card, source });
  }
}
