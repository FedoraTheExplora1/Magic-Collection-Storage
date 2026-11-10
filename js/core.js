// Shared logic used by both the website (browser) and the daily price job (Node).
// No DOM, no imports — keep it that way so both can load it.

export const API = 'https://api.scryfall.com';
export const DELAY = 550;   // Scryfall asks for <= 2 requests/second on /cards/collection, /named and /search
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const todayUTC = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// CSV / list parsing
// ---------------------------------------------------------------------------
export function parseCSV(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const cnt = { ',': 0, ';': 0, '\t': 0 }; let inQ = false;
  for (const ch of first) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in cnt) cnt[ch]++; }
  let d = ','; if (cnt['\t'] > cnt[d]) d = '\t'; if (cnt[';'] > cnt[d]) d = ';';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f.trim() === '') { q = true; f = ''; }
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

const ALIASES = {
  name: ['name', 'card name', 'card', 'cardname', 'card title'],
  qty: ['quantity', 'count', 'qty', 'amount', 'copies', 'total quantity', 'have', 'owned', 'number owned'],
  set: ['set code', 'set', 'edition code', 'setcode', 'edition', 'expansion code', 'set id'],
  setName: ['set name', 'edition name', 'expansion'],
  cn: ['collector number', 'card number', 'collector #', 'collectornumber', 'cn', 'number', 'card #', '#', 'collector no', 'collector no.'],
  id: ['scryfall id', 'scryfallid', 'scryfall uuid'],
  foil: ['foil', 'finish', 'printing', 'is foil', 'foil/etched', 'treatment']
};
const normH = h => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[_\s]+/g, ' ');

function mapHeader(row) {
  const h = row.map(normH), m = {};
  for (const key in ALIASES) {
    for (const a of ALIASES[key]) {
      const i = h.indexOf(a);
      if (i !== -1 && !Object.values(m).includes(i)) { m[key] = i; break; }
    }
  }
  return (m.name !== undefined || m.id !== undefined) ? m : null;
}

export function parseFinish(v) {
  v = (v || '').trim().toLowerCase();
  if (!v) return 'nonfoil';
  if (/etch/.test(v)) return 'etched';
  if (/non|normal|regular|false|^no$|^n$|^0$/.test(v)) return 'nonfoil';
  if (/foil|^true$|^yes$|^y$|^1$|^f$/.test(v)) return 'foil';
  return 'nonfoil';
}
const isSetCode = s => /^[a-z0-9]{2,6}$/i.test(s || '');

// Returns [{line, name, id, set, setName, cn, finish, qty}]
export function parseInput(text) {
  text = text.replace(/^﻿/, '');
  const rows = parseCSV(text);
  const hdr = rows.length ? mapHeader(rows[0]) : null;
  const items = [];
  if (hdr) {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r], g = k => hdr[k] !== undefined ? (row[hdr[k]] || '').trim() : '';
      const name = g('name'), id = g('id');
      if (!name && !id) continue;
      let set = g('set'), setName = g('setName');
      if (set && !isSetCode(set)) { setName = setName || set; set = ''; }
      const qRaw = g('qty').replace(/[^\d]/g, '');
      items.push({
        line: row.map(x => x.trim()).filter(Boolean).join(', '), name,
        id: /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : '',
        set: set.toLowerCase(), setName, cn: g('cn').replace(/^#/, ''),
        finish: parseFinish(g('foil')), qty: qRaw === '' ? 1 : parseInt(qRaw, 10)
      });
    }
  } else {
    // plain list: "4 Lightning Bolt", "1x Sol Ring (C21) 263 *F*", "1 Shivan Fire (PLST) DOM-142", or just names
    const re = /^\s*(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([^\s*]+))?)?(?:\s+\*([FE])\*)?\s*$/i;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^(\/\/|#)/.test(line) || /^(deck|sideboard|commander|companion|maybeboard|about|main(board)?)\s*:?$/i.test(line)) continue;
      const m = line.match(re); if (!m) continue;
      items.push({
        line, name: m[2].trim(), id: '', set: (m[3] || '').toLowerCase(), setName: '',
        cn: m[3] ? (m[4] || '') : '', finish: m[5] ? (m[5].toUpperCase() === 'E' ? 'etched' : 'foil') : 'nonfoil',
        qty: m[1] ? parseInt(m[1], 10) : 1
      });
    }
  }
  return items.filter(i => i.qty > 0);
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------
export const LIST_RE = /^([a-z0-9]{2,6})-([a-z0-9★†]+)$/i;   // The List: "DOM-142" = Dominaria #142
export const USD_K = ['usd', 'usd_foil', 'usd_etched'];
export const EUR_K = ['eur', 'eur_foil', 'eur_etched'];
const PRICE_KEYS = [...USD_K, ...EUR_K];
const hasK = (p, ks) => !!p && ks.some(k => p[k] != null);
export const hasAnyPrice = p => hasK(p, USD_K) || hasK(p, EUR_K);
export const hasAllPrices = p => hasK(p, USD_K) && hasK(p, EUR_K);

export function pickPrices(p) {
  const o = {};
  for (const k of PRICE_KEYS) o[k] = p && p[k] != null && p[k] !== '' ? Number(p[k]) : null;
  return o;
}

// Price for a finish from a prices object, falling back to another finish if needed.
// base = 'usd' | 'eur'. Returns {v, usedFinish} or null.
export function priceFrom(prices, finish, base) {
  if (!prices) return null;
  const want = finish === 'foil' ? base + '_foil' : finish === 'etched' ? base + '_etched' : base;
  let v = prices[want], used = want;
  if (v == null) for (const k of [base, base + '_foil', base + '_etched']) if (prices[k] != null) { v = prices[k]; used = k; break; }
  if (v == null) return null;
  return { v: Number(v), usedFinish: used.endsWith('_foil') ? 'foil' : used.endsWith('_etched') ? 'etched' : 'nonfoil' };
}

// Scryfall card object -> row for the `cards` table (without alt fields)
export function cardRow(c) {
  const face0 = (c.card_faces && c.card_faces[0]) || {};
  const img = c.image_uris || face0.image_uris || {};
  return {
    id: c.id, oracle_id: c.oracle_id || face0.oracle_id || null, name: c.name,
    set_code: c.set, set_name: c.set_name, collector_number: c.collector_number, rarity: c.rarity,
    image_url: img.normal || null, scryfall_uri: c.scryfall_uri, prices: pickPrices(c.prices),
    updated_at: new Date().toISOString()
  };
}
export const priceRow = (c, date) => ({ card_id: c.id, date, ...pickPrices(c.prices) });

// ---------------------------------------------------------------------------
// Scryfall client
// ---------------------------------------------------------------------------
function identFor(it) {
  if (it.id) return { id: it.id };
  if (it.set && it.cn) return { set: it.set, collector_number: it.cn };
  if (it.name && it.set) return { name: it.name, set: it.set };
  return { name: it.name };
}
const keyOf = o => JSON.stringify(Object.keys(o).sort().map(k => [k, String(o[k]).toLowerCase()]));

export function makeScryfall({ headers = { Accept: 'application/json' }, delay = DELAY } = {}) {
  let last = 0;
  async function req(url, opts = {}, tries = 4) {
    for (let t = 0; t < tries; t++) {
      const wait = last + delay - Date.now(); if (wait > 0) await sleep(wait);
      last = Date.now();
      const r = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
      if (r.status === 429) { await sleep(2000 * (t + 1)); continue; }
      return r;
    }
    throw new Error('Scryfall rate limit hit, try again in a minute');
  }

  // idents: [{id} | {set, collector_number} | {name} | {name, set}] -> Map(keyOf(ident) -> card)
  async function collection(idents, onProgress) {
    const out = new Map();
    for (let i = 0; i < idents.length; i += 75) {
      const batch = idents.slice(i, i + 75);
      const r = await req(API + '/cards/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: batch })
      });
      if (!r.ok) throw new Error('Scryfall error ' + r.status);
      const j = await r.json();
      const missing = new Set((j.not_found || []).map(keyOf));
      let p = 0;
      for (const id of batch) {
        if (missing.has(keyOf(id))) continue;
        const card = (j.data || [])[p++]; if (card) out.set(keyOf(id), card);
      }
      onProgress && onProgress(Math.min(i + 75, idents.length) / idents.length);
    }
    return out;
  }

  async function fuzzy(name) {
    const r = await req(API + '/cards/named?fuzzy=' + encodeURIComponent(name));
    return r.ok ? r.json() : null;
  }

  async function cheapestOther(card) {
    const oid = card.oracle_id || (card.card_faces && card.card_faces[0] && card.card_faces[0].oracle_id);
    if (!oid) return null;
    const r = await req(API + '/cards/search?unique=prints&order=usd&dir=asc&q=' + encodeURIComponent(`oracleid:${oid} game:paper`));
    if (!r.ok) return null;
    const list = ((await r.json()).data || []).filter(c => c.id !== card.id);
    return list.find(c => c.prices && c.prices.usd != null) || list.find(c => hasAnyPrice(c.prices)) || null;
  }

  // Every paper printing of a card, newest first (follows Scryfall's pagination)
  async function printings(card) {
    const oid = card.oracle_id || (card.card_faces && card.card_faces[0] && card.card_faces[0].oracle_id);
    const q = oid ? `oracleid:${oid} include:extras game:paper` : `!"${card.name}" include:extras game:paper`;
    let url = API + '/cards/search?unique=prints&order=released&dir=desc&q=' + encodeURIComponent(q), out = [];
    for (let page = 0; url && page < 8; page++) {
      const r = await req(url);
      if (!r.ok) break;
      const j = await r.json();
      out = out.concat(j.data || []);
      url = j.has_more ? j.next_page : null;
    }
    return out;
  }

  return { req, collection, fuzzy, cheapestOther, printings, keyOf };
}

// For printings with no price: List cards ("DOM-142") -> original printing; otherwise cheapest other printing.
// cards: objects with {id, collector_number, prices, oracle_id?}. Returns Map(cardId -> {alt: scryfallCard, note})
export async function findAlts(cards, sf, onStatus = () => {}) {
  const out = new Map();
  const list = cards.map(c => [c, (c.collector_number || '').match(LIST_RE)]).filter(([, m]) => m);
  if (list.length) {
    onStatus(`Checking original printings for ${list.length} List card${list.length === 1 ? '' : 's'}…`);
    const ids = list.map(([, m]) => ({ set: m[1].toLowerCase(), collector_number: m[2] }));
    const res = await sf.collection(ids);
    list.forEach(([c], i) => {
      const alt = res.get(keyOf(ids[i]));
      if (alt && hasAnyPrice(alt.prices)) out.set(c.id, { alt, note: `original printing, ${alt.set_name} #${alt.collector_number}` });
    });
  }
  const rest = cards.filter(c => !out.has(c.id) && !hasAnyPrice(c.prices));
  for (let i = 0; i < rest.length; i++) {
    onStatus(`Finding another printing with a price ${i + 1}/${rest.length}: ${rest[i].name}`);
    try {
      const alt = await sf.cheapestOther(rest[i]);
      if (alt) out.set(rest[i].id, { alt, note: `cheapest other printing, ${alt.set_name} #${alt.collector_number}` });
    } catch (e) { /* skip */ }
  }
  return out;
}

// Resolve parsed items to Scryfall cards. Sets it.card, it.alt, it.altNote, it.loose, it.fuzzy.
export async function resolveItems(items, sf, { onStatus = () => {}, onProgress = () => {} } = {}) {
  const groups = new Map();
  for (const it of items) {
    if (!it.name && !it.id) continue;
    const id = identFor(it), k = keyOf(id);
    if (!groups.has(k)) groups.set(k, { id, items: [] });
    groups.get(k).items.push(it);
  }
  const all = [...groups.values()];
  onStatus(`Looking up ${all.length} unique card${all.length === 1 ? '' : 's'}…`);
  const res1 = await sf.collection(all.map(g => g.id), onProgress);
  for (const g of all) g.card = res1.get(keyOf(g.id)) || null;

  // set/number didn't match -> try by name only
  const retry = all.filter(g => !g.card && g.items[0].name && !(g.id.name && !g.id.set));
  if (retry.length) {
    onStatus(`Retrying ${retry.length} by name only…`);
    const ids = retry.map(g => ({ name: g.items[0].name }));
    const res2 = await sf.collection(ids);
    retry.forEach((g, i) => { const c = res2.get(keyOf(ids[i])); if (c) { g.card = c; g.loose = true; } });
  }

  // typos / missing accents / partial DFC names
  const fz = all.filter(g => !g.card && g.items[0].name);
  for (let i = 0; i < fz.length; i++) {
    onStatus(`Fuzzy matching ${i + 1}/${fz.length}: ${fz[i].items[0].name}`);
    try { const c = await sf.fuzzy(fz[i].items[0].name); if (c) { fz[i].card = c; fz[i].loose = fz[i].fuzzy = true; } } catch (e) {}
  }

  // printings with no price
  const needs = [...new Map(all.filter(g => g.card && !hasAllPrices(g.card.prices)).map(g => [g.card.id, g.card])).values()];
  const alts = needs.length ? await findAlts(needs, sf, onStatus) : new Map();

  for (const g of all) for (const it of g.items) {
    it.card = g.card; it.loose = !!g.loose; it.fuzzy = !!g.fuzzy;
    const a = g.card && alts.get(g.card.id);
    it.alt = a ? a.alt : null; it.altNote = a ? a.note : '';
  }
  return items;
}
