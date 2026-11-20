// Watch Inventory: Metabase proxy for the warehouse (31879) and retrieved items (47950) questions.
// Env: METABASE_HOST, METABASE_API_KEY, optional WAREHOUSE_CARD_ID (or WATCH_CARD_ID) and RETRIEVED_CARD_ID.
// Uses the JSON export endpoint so results aren't capped at Metabase's 2,000-row /query limit.
// Reads the question's own filters (template tags) and only sends the ones it has.

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
    return (meta[card] = { name: j.name || `Question ${card}`, tags, at: Date.now() });
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
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST' }); }

  const host = (process.env.METABASE_HOST || '').replace(/\/+$/, '');
  const key = process.env.METABASE_API_KEY;
  let body0 = req.body;
  if (typeof body0 === 'string') { try { body0 = JSON.parse(body0); } catch { body0 = {}; } }
  const source = (body0 && body0.source) === 'retrieved' ? 'retrieved' : 'warehouse';
  const card = source === 'retrieved'
    ? (process.env.RETRIEVED_CARD_ID || '47950')
    : (process.env.WAREHOUSE_CARD_ID || process.env.WATCH_CARD_ID || '31879');
  if (!host || !key) return res.status(500).json({ error: 'Set METABASE_HOST and METABASE_API_KEY in Vercel' });

  const params = (body0 && body0.params) || {};

  const { name, tags } = await cardMeta(host, key, card);
  const tagMap = mapTags(tags);
  const parameters = Object.entries(params)
    .filter(([k, v]) => tagMap[k] && v != null && String(v).trim() !== '')
    .map(([k, v]) => {
      const t = tagMap[k], def = tags[t] || {}, value = String(v).trim();
      return def.type === 'dimension'
        ? { type: 'string/=', target: ['dimension', ['template-tag', t]], value: [value] }
        : { type: def.type === 'number' ? 'number/=' : 'category', target: ['variable', ['template-tag', t]], value: def.type === 'number' && !isNaN(+value) ? +value : value };
    });

  const send = (cols, rows, via) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      card, name, source, via, filters: Object.keys(tagMap), count: rows.length,
      truncated: via === 'query' && rows.length >= 2000, cols, rows
    });
  };

  // 1) Full export (no row cap)
  try {
    const r = await fetch(`${host}/api/card/${card}/query/json`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: 'false' })
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j)) {
        const keys = j.length ? Object.keys(j[0]) : [];
        return send(keys.map(normKey), j.map(o => keys.map(k => o[k])), 'export');
      }
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
    return send(j.data.cols.map(c => normKey(c.name || c.display_name)), j.data.rows, 'query');
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Metabase: ${e.message}`, card, source });
  }
}
