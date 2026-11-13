import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { parseInput, makeScryfall, resolveItems, findAlts, cardRow, priceRow, priceFrom, hasAllPrices, todayUTC } from './js/core.js';

const $ = s => document.querySelector(s);
const sf = makeScryfall();
const state = {
  user: null, entries: [], cards: new Map(), past: new Map(), pastDate: null, snapshots: [],
  rate: null, rateDate: null, currency: 'AUD', useAlt: true,
  sortKey: 'total', sortDir: -1, filter: '', busy: false,
  view: 'collection', setSort: 'value', setFilter: '', openSets: new Set(),
  mv: { period: '7', mode: 'unit', unit: 'abs' }, pastByPeriod: {}
};

// ---------- prefs ----------
try {
  state.currency = localStorage.getItem('mcs.currency') || 'AUD';
  state.useAlt = localStorage.getItem('mcs.useAlt') !== '0';
} catch (e) {}
const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// ---------- views ----------
function show(view) { for (const v of ['setupView', 'loginView', 'appView']) $('#' + v).hidden = v !== view; }

if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT') || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('YOUR-')) {
  show('setupView');
  throw new Error('config.js not filled in');
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- auth ----------
sb.auth.onAuthStateChange((_event, session) => {
  // don't call other supabase methods inside this callback (can deadlock) — defer
  setTimeout(() => setUser(session ? session.user : null), 0);
});
let authReady = false;
async function setUser(u) {
  if (authReady && (u && u.id) === (state.user && state.user.id)) return;
  authReady = true;
  state.user = u;
  if (!u) { state.entries = []; show('loginView'); return; }
  show('appView');
  await loadAll();
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginBtn').disabled = true; $('#loginErr').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
  $('#loginBtn').disabled = false;
  if (error) $('#loginErr').textContent = error.message;
});
$('#signOutBtn').addEventListener('click', () => sb.auth.signOut());

// ---------- data helpers ----------
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function fetchAll(build, page = 1000) {
  let out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < page) return out;
  }
}
async function must(p) { const { data, error } = await p; if (error) throw error; return data; }
async function upsertChunks(table, rows, onConflict, size = 500) {
  for (const c of chunk(rows, size)) await must(sb.from(table).upsert(c, { onConflict }));
}
async function loadCards(ids) {
  const need = [...new Set(ids)].filter(id => id && !state.cards.has(id));
  await pmap(chunk(need, 120), async c => {
    for (const row of await must(sb.from('cards').select('*').in('id', c))) state.cards.set(row.id, row);
  });
}
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// run fn over items with limited parallelism
async function pmap(items, fn, n = 6) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function loadRate() {
  const rows = await must(sb.from('fx_rates').select('*').order('date', { ascending: false }).limit(1));
  if (rows.length) { state.rate = +rows[0].aud_per_usd; state.rateDate = rows[0].date; return; }
  await liveRate();
}
async function liveRate() {
  for (const u of ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD', 'https://api.frankfurter.app/latest?from=USD&to=AUD']) {
    try { const j = await (await fetch(u)).json(); if (j.rates && j.rates.AUD) { state.rate = j.rates.AUD; state.rateDate = j.date; return; } } catch (e) {}
  }
  state.rate = 1.53; state.rateDate = 'estimate';
}

async function loadPast() {
  state.past = new Map(); state.pastDate = null;
  let d = await must(sb.from('price_history').select('date').lte('date', daysAgo(7)).order('date', { ascending: false }).limit(1));
  if (!d.length) d = await must(sb.from('price_history').select('date').lt('date', todayUTC()).order('date', { ascending: true }).limit(1));
  if (!d.length) return;
  state.pastDate = d[0].date;
  const ids = [...new Set(state.entries.flatMap(e => { const c = state.cards.get(e.card_id); return [e.card_id, c && c.alt_id]; }).filter(Boolean))];
  await pmap(chunk(ids, 120), async c => {
    const rows = await must(sb.from('price_history').select('card_id,usd,usd_foil,usd_etched,eur,eur_foil,eur_etched').eq('date', state.pastDate).in('card_id', c));
    for (const r of rows) state.past.set(r.card_id, r);
  });
}

// Fast path: one request via the collection_snapshot() database function.
// Falls back to the older multi-request loader if the function hasn't been added yet.
let useRpc = true;
async function loadAll() {
  if (!state.entries.length) $('#lastUpdated').textContent = 'Loading your collection…';
  try {
    let data = null;
    if (useRpc) {
      const r = await sb.rpc('collection_snapshot');
      if (r.error) {
        if (r.error.code === 'PGRST202' || /collection_snapshot/.test(r.error.message || '')) { useRpc = false; console.info('collection_snapshot() not found, using slower loader. Re-run supabase/schema.sql to speed this up.'); }
        else throw r.error;
      } else data = r.data;
    }
    if (data) {
      state.entries = data.entries || [];
      state.cards = new Map((data.cards || []).map(c => [c.id, c]));
      state.pastDate = data.past_date || null;
      state.past = new Map((data.past || []).map(p => [p.card_id, p]));
      state.snapshots = data.snapshots || [];
      if (data.fx) { state.rate = +data.fx.aud_per_usd; state.rateDate = data.fx.date; } else await liveRate();
    } else {
      state.cards = new Map();
      state.entries = await fetchAll(() => sb.from('collection').select('id,card_id,finish,quantity,added_at').order('id'));
      const snaps = fetchAll(() => sb.from('value_snapshots').select('date,value_usd,value_eur,value_aud,card_count').order('date'));
      const rate = loadRate();
      await loadCards(state.entries.map(e => e.card_id));
      await loadCards([...state.cards.values()].map(c => c.alt_id));
      await loadPast();
      state.snapshots = await snaps; await rate;
    }
    state.pastByPeriod = {};
    render();
  } catch (e) {
    console.error(e);
    $('#lastUpdated').innerHTML = `<span class="down">Couldn't load your collection: ${esc(e.message || e)}</span>`;
  }
}

// ---------- pricing ----------
const base = () => state.currency === 'EUR' ? 'eur' : 'usd';
// past = a Map(card_id -> price row) for an earlier date, or omitted for today's prices
function unitPrice(e, past = null) {
  const card = state.cards.get(e.card_id); if (!card) return null;
  const src = past ? past.get(e.card_id) : card.prices;
  let r = priceFrom(src, e.finish, base()), via = null;
  if (!r && state.useAlt && card.alt_id) {
    const alt = state.cards.get(card.alt_id);
    r = priceFrom(past ? past.get(card.alt_id) : alt && alt.prices, e.finish, base());
    if (r) via = alt;
  }
  if (!r) return null;
  const v = state.currency === 'AUD' ? r.v * (state.rate || 0) : r.v;
  return { v, usedFinish: r.usedFinish, via };
}

// ---------- render ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SYM = { AUD: 'A$', USD: 'US$', EUR: '€' };
const money = v => v == null ? '—' : (v < 0 ? '−' : '') + SYM[state.currency] + Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = v => (v > 0 ? '+' : '') + money(v);
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

const COLS = [
  ['qty', 'Qty', 'num'], ['name', 'Card', ''], ['set', 'Set', ''], ['cn', '#', ''], ['finish', 'Finish', ''],
  ['unit', 'Each', 'num'], ['delta', 'Change', 'num'], ['total', 'Total', 'num'], ['', '', 'nosort']
];

function rowFor(e) {
  const c = state.cards.get(e.card_id); if (!c) return null;
  const now = unitPrice(e), then = unitPrice(e, state.past);
  return { e, c, now, unit: now ? now.v : null, total: now ? now.v * e.quantity : null, delta: diff(now, then) };
}
// only compare like with like (same finish, same printing) so a missing foil price last week doesn't fake a jump
const diff = (now, then) => now && then && now.usedFinish === then.usedFinish && (now.via && now.via.id) === (then.via && then.via.id) ? now.v - then.v : null;
const rows = () => state.entries.map(rowFor).filter(Boolean);

// what = which parts to redraw: stats / table / chart (default: all)
// (table = the active tab's main content)
function render(what = { stats: true, table: true, chart: true }) {
  $('#currency').value = state.currency;
  $('#useAlt').checked = state.useAlt;
  $('#emptyMsg').hidden = state.entries.length > 0;
  $('.tablewrap').hidden = state.entries.length === 0;
  if (!state.entries.length) $('#importPanel').open = true;
  $('#tabCountCollection').textContent = state.entries.length ? state.entries.length.toLocaleString() : '';
  $('#tabCountSets').textContent = state.entries.length ? new Set(state.entries.map(e => (state.cards.get(e.card_id) || {}).set_code)).size : '';
  if (what.stats) renderStats();
  if (state.view === 'collection') {
    if (what.table) renderTable();
    if (what.chart) renderChart();
  } else if (state.view === 'sets') { if (what.table || what.chart) renderSets(); }
  else if (state.view === 'movers') { if (what.table || what.chart) renderMovers(); }
}

function renderStats(all = rows()) {
  $('#rateText').textContent = state.rate ? `1 USD = ${state.rate.toFixed(4)} AUD${state.rateDate ? ', ' + state.rateDate : ''}` : '…';
  let updated = ''; for (const c of state.cards.values()) if (c.updated_at > updated) updated = c.updated_at;
  $('#lastUpdated').textContent = updated ? 'Prices last updated ' + new Date(updated).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : 'No cards yet';
  let total = 0, cards = 0, d = 0, prev = 0;
  for (const r of all) {
    total += r.total || 0; cards += r.e.quantity;
    if (r.delta != null) { d += r.delta * r.e.quantity; prev += (r.unit - r.delta) * r.e.quantity; }
  }
  $('#sTotal').textContent = money(total);
  $('#sCards').textContent = cards.toLocaleString();
  $('#sUnique').textContent = state.entries.length.toLocaleString();
  if (state.pastDate) {
    $('#sChangeLabel').textContent = 'Change since ' + fmtDate(state.pastDate);
    $('#sChange').innerHTML = `<span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${signed(d)}</span>` +
      (prev ? ` <span class="note">${(d / prev * 100).toFixed(1)}%</span>` : '');
  } else { $('#sChangeLabel').textContent = 'Change'; $('#sChange').innerHTML = '<span class="note">after first daily update</span>'; }
}

// The table is drawn in pages of PAGE rows; more are added as you scroll down.
const PAGE = 150;
let tableRows = [], shown = 0;
function renderTable() {
  $('#thead').innerHTML = COLS.map(([k, label, cls]) =>
    `<th data-k="${k}" class="${cls}">${label}${k && state.sortKey === k ? ' <span class="arrow">' + (state.sortDir < 0 ? '▼' : '▲') + '</span>' : ''}</th>`).join('');
  const f = state.filter.trim().toLowerCase();
  let list = rows();
  if (f) list = list.filter(r => (r.c.name + ' ' + r.c.set_code + ' ' + r.c.set_name).toLowerCase().includes(f));
  const k = state.sortKey, dir = state.sortDir;
  const val = r => ({ qty: r.e.quantity, name: r.c.name, set: r.c.set_name || '', cn: parseFloat(r.c.collector_number) || 0,
    finish: r.e.finish, unit: r.unit ?? -Infinity, delta: r.delta ?? -Infinity, total: r.total ?? -Infinity })[k];
  list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.c.name.localeCompare(b.c.name); });
  tableRows = list; shown = 0;
  $('#tbody').innerHTML = list.length || !state.entries.length ? '' : '<tr><td colspan="9" class="muted">No matches for that filter.</td></tr>';
  appendRows();
}
function appendRows() {
  const next = tableRows.slice(shown, shown + PAGE);
  if (next.length) $('#tbody').insertAdjacentHTML('beforeend', next.map(rowHtml).join(''));
  shown += next.length;
  const more = $('#more');
  more.hidden = shown >= tableRows.length;
  more.textContent = `Showing ${shown.toLocaleString()} of ${tableRows.length.toLocaleString()}. Scroll for more`;
}
new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && shown < tableRows.length) appendRows(); }, { rootMargin: '800px' }).observe($('#more'));

function rowHtml(r) {
  const { e, c, now } = r;
  const notes = (now && now.via ? `<span class="fb via" title="This printing has no price; using the ${esc(c.alt_note || 'printing ' + now.via.set_code.toUpperCase() + ' #' + now.via.collector_number)}">(via ${esc(now.via.set_code.toUpperCase())} #${esc(now.via.collector_number)})</span>` : '') +
    (now && now.usedFinish !== e.finish ? `<span class="fb" title="No ${e.finish} price listed, showing ${now.usedFinish} price">(${now.usedFinish} price)</span>` : '');
  const delta = r.delta == null || Math.abs(r.delta) < 0.005 ? '<span class="muted">—</span>'
    : `<span class="delta ${r.delta > 0 ? 'up' : 'down'}">${signed(r.delta)}</span>`;
  return `<tr data-id="${e.id}" data-img="${esc(c.image_url || '')}">
    <td class="num"><input class="qty" type="number" min="0" value="${e.quantity}" title="Change quantity (0 removes it)"></td>
    <td class="name"><span class="dot r-${esc(c.rarity)}"></span><a href="${esc(c.scryfall_uri)}" target="_blank" rel="noopener">${esc(c.name)}</a></td>
    <td><button class="printing" title="Change printing or finish">${esc((c.set_code || '').toUpperCase())} <span class="muted">${esc(c.set_name)}</span><span class="pen">✎</span></button></td>
    <td class="muted">${esc(c.collector_number)}</td>
    <td>${e.finish === 'nonfoil' ? '<span class="badge">normal</span>' : `<span class="badge ${e.finish}">${e.finish}</span>`}</td>
    <td class="num">${money(r.unit)}${notes}</td>
    <td class="num">${delta}</td>
    <td class="num"><strong>${money(r.total)}</strong></td>
    <td><button class="del" title="Remove from collection">×</button></td>
  </tr>`;
}
// redraw a single row in place (after a quantity change)
function updateRow(e) {
  const tr = $(`#tbody tr[data-id="${e.id}"]`), r = rowFor(e);
  if (tr && r) tr.outerHTML = rowHtml(r);
}
function removeRow(id) {
  const tr = $(`#tbody tr[data-id="${id}"]`); if (tr) tr.remove();
  const i = tableRows.findIndex(r => r.e.id === id);
  if (i !== -1) { tableRows.splice(i, 1); if (i < shown) shown--; }
  appendRows();
}

// ---------- chart ----------
function renderChart() {
  const el = $('#chart');
  const key = { AUD: 'value_aud', USD: 'value_usd', EUR: 'value_eur' }[state.currency];
  const pts = state.snapshots.filter(s => s[key] != null).map(s => ({ d: s.date, v: +s[key] }));
  if (pts.length < 2) {
    $('#chartNote').textContent = '';
    el.innerHTML = `<div class="empty">Your value history will build up here once the daily price update has run a couple of times.</div>`;
    return;
  }
  const first = pts[0].v, last = pts[pts.length - 1].v, ch = last - first;
  $('#chartNote').innerHTML = `${fmtDate(pts[0].d)} – ${fmtDate(pts[pts.length - 1].d)}: <span class="${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${signed(ch)}</span>`;
  const W = Math.max(320, el.clientWidth), H = 220, pl = 74, pr = 14, pt = 12, pb = 26;
  const vs = pts.map(p => p.v); let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  // round the axis to tidy steps (1, 2, 2.5, 5 × 10^n)
  const raw = (hi - lo) / 3, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  lo = Math.max(0, Math.floor(lo / step) * step); hi = Math.ceil(hi / step) * step;
  if (hi - lo < step * 2) hi = lo + step * 2;
  const x = i => pl + (W - pl - pr) * i / (pts.length - 1), y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const axis = v => SYM[state.currency] + v.toLocaleString('en-AU', { maximumFractionDigits: step < 1 ? 2 : 0 });
  let grid = '';
  for (let v = lo; v <= hi + step / 1000; v += step) { const yy = y(v).toFixed(1);
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-dasharray="2 4"/>
      <text x="${pl - 10}" y="${yy}" fill="var(--dim)" font-size="11" font-family="var(--mono)" text-anchor="end" dominant-baseline="middle">${axis(v)}</text>`; }
  const idx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
  const xl = idx.map(i => `<text x="${x(i)}" y="${H - 6}" fill="var(--dim)" font-size="11" font-family="var(--mono)" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${fmtDate(pts[i].d)}</text>`).join('');
  el.innerHTML = `<svg width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d0d6e0" stop-opacity=".14"/><stop offset="1" stop-color="#d0d6e0" stop-opacity="0"/></linearGradient></defs>
    ${grid}${xl}
    <path d="${line}L${x(pts.length - 1)},${H - pb}L${x(0)},${H - pb}Z" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="var(--mist)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle id="hdot" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" style="display:none"/>
    <rect x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent" id="hover"/>
  </svg><div class="tip" style="display:none"></div>`;
  const tip = el.querySelector('.tip'), dot = el.querySelector('#hdot');
  el.querySelector('#hover').addEventListener('mousemove', ev => {
    const bx = ev.offsetX, i = Math.max(0, Math.min(pts.length - 1, Math.round((bx - pl) / (W - pl - pr) * (pts.length - 1))));
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(pts[i].v)); dot.style.display = '';
    tip.style.left = x(i) + 'px'; tip.style.top = y(pts[i].v) + 'px'; tip.style.display = '';
    tip.innerHTML = `<strong>${money(pts[i].v)}</strong> <span class="muted">${fmtDate(pts[i].d)}</span>`;
  });
  el.querySelector('#hover').addEventListener('mouseleave', () => { tip.style.display = 'none'; dot.style.display = 'none'; });
}
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderChart, 150); });

// ---------- table interactions ----------
$('#thead').addEventListener('click', e => {
  const th = e.target.closest('th'); if (!th || !th.dataset.k) return;
  const k = th.dataset.k;
  if (state.sortKey === k) state.sortDir *= -1;
  else { state.sortKey = k; state.sortDir = ['qty', 'unit', 'delta', 'total'].includes(k) ? -1 : 1; }
  render({ table: true });
});
let filterTimer;
$('#filter').addEventListener('input', e => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { state.filter = e.target.value; render({ table: true }); }, 120);
});
$('#currency').addEventListener('change', e => { state.currency = e.target.value; savePref('mcs.currency', state.currency); render(); });
$('#useAlt').addEventListener('change', e => { state.useAlt = e.target.checked; savePref('mcs.useAlt', state.useAlt ? '1' : '0'); render({ stats: true, table: true }); });

// Quantity edits and deletes update the screen immediately, then save in the background (undone if the save fails).
async function removeEntry(entry) {
  const i = state.entries.indexOf(entry);
  state.entries.splice(i, 1); removeRow(entry.id); render({ stats: true });
  try { await must(sb.from('collection').delete().eq('id', entry.id)); }
  catch (err) { state.entries.splice(i, 0, entry); render({ stats: true, table: true }); toast('Delete failed: ' + err.message); }
}
$('#tbody').addEventListener('change', async e => {
  if (!e.target.classList.contains('qty')) return;
  const id = +e.target.closest('tr').dataset.id, q = parseInt(e.target.value, 10);
  const entry = state.entries.find(x => x.id === id); if (!entry || isNaN(q)) return;
  if (q <= 0) {
    if (confirm(`Remove ${state.cards.get(entry.card_id).name} from your collection?`)) removeEntry(entry);
    else e.target.value = entry.quantity;
    return;
  }
  const old = entry.quantity; if (q === old) return;
  entry.quantity = q; updateRow(entry); render({ stats: true });
  try { await must(sb.from('collection').update({ quantity: q }).eq('id', id)); }
  catch (err) { entry.quantity = old; updateRow(entry); render({ stats: true }); toast('Save failed: ' + err.message); }
});
$('#tbody').addEventListener('click', e => {
  const pb = e.target.closest('.printing');
  if (pb) { openPrintings(+pb.closest('tr').dataset.id); return; }
  if (!e.target.classList.contains('del')) return;
  const id = +e.target.closest('tr').dataset.id, entry = state.entries.find(x => x.id === id);
  if (entry && confirm(`Remove ${state.cards.get(entry.card_id).name} from your collection?`)) removeEntry(entry);
});

// hover preview (table rows, set lists, movers)
const pv = $('#preview');
document.addEventListener('mousemove', e => {
  const el = e.target.closest && e.target.closest('[data-img]'), src = el && el.dataset.img;
  if (!src || e.target.closest('input,button,.modal-box')) { if (pv.style.display !== 'none') pv.style.display = 'none'; return; }
  if (pv.getAttribute('src') !== src) pv.src = src;
  const w = 244, h = 340;
  let x = e.clientX + 24, y = e.clientY - h / 2;
  if (x + w > innerWidth - 8) x = e.clientX - w - 24;
  y = Math.max(8, Math.min(y, innerHeight - h - 8));
  pv.style.left = x + 'px'; pv.style.top = y + 'px'; pv.style.display = 'block';
});

function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', ms); }

// ---------- import ----------
const drop = $('#drop'), fileIn = $('#file');
drop.addEventListener('click', () => fileIn.click());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
fileIn.addEventListener('change', () => { if (fileIn.files[0]) readFile(fileIn.files[0]); fileIn.value = ''; });
$('#importBtn').addEventListener('click', () => { const t = $('#paste').value.trim(); if (t) doImport(t); else importStatus('Paste something first.', true); });
function readFile(f) { const r = new FileReader(); r.onload = () => doImport(String(r.result)); r.onerror = () => importStatus('Could not read that file.', true); r.readAsText(f); }

function importStatus(t, err) { const s = $('#importStatus'); s.textContent = t; s.className = 'status' + (err ? ' err' : ''); }
function progress(f) {
  const p = $('#progress');
  if (f === null) { setTimeout(() => p.style.display = 'none', 400); return; }
  p.style.display = 'block'; p.firstElementChild.style.width = Math.round(f * 100) + '%';
}
function setBusy(b) {
  state.busy = b;
  for (const s of ['#importBtn', '#refreshBtn']) $(s).disabled = b;
  drop.style.pointerEvents = b ? 'none' : '';
}

async function doImport(text) {
  if (state.busy) return;
  const items = parseInput(text);
  if (!items.length) { importStatus("Couldn't find any cards. Make sure there's a column called Name (or Card Name), or paste one card per line.", true); return; }
  const replace = document.querySelector('input[name=mode]:checked').value === 'replace';
  if (replace && state.entries.length && !confirm(`Replace your whole collection (${state.entries.length} entries) with this list?`)) return;
  setBusy(true); progress(0); $('#importResult').innerHTML = '';
  try {
    await resolveItems(items, sf, { onStatus: s => importStatus(s), onProgress: progress });
    const found = items.filter(i => i.card), missing = items.filter(i => !i.card);
    importStatus('Saving…');

    // cards: alternate printings first (foreign key), then the cards themselves
    const altRows = new Map(), mainRows = new Map(), priceRows = new Map(), today = todayUTC();
    for (const it of found) if (it.alt) { altRows.set(it.alt.id, cardRow(it.alt)); priceRows.set(it.alt.id, priceRow(it.alt, today)); }
    for (const it of found) {
      mainRows.set(it.card.id, { ...cardRow(it.card), alt_id: it.alt ? it.alt.id : null, alt_note: it.alt ? it.altNote : null });
      priceRows.set(it.card.id, priceRow(it.card, today));
    }
    for (const id of mainRows.keys()) altRows.delete(id);
    await upsertChunks('cards', [...altRows.values()], 'id');
    await upsertChunks('cards', [...mainRows.values()], 'id');
    await upsertChunks('price_history', [...priceRows.values()], 'card_id,date');

    // collection
    const agg = new Map();
    for (const it of found) { const k = it.card.id + '|' + it.finish; agg.set(k, (agg.get(k) || 0) + it.qty); }
    const existing = new Map(state.entries.map(e => [e.card_id + '|' + e.finish, e]));
    const coll = [...agg].map(([k, q]) => {
      const [card_id, finish] = k.split('|');
      return { user_id: state.user.id, card_id, finish, quantity: replace ? q : q + (existing.get(k) ? existing.get(k).quantity : 0) };
    });
    await upsertChunks('collection', coll, 'user_id,card_id,finish');
    if (replace) {
      const drop = state.entries.filter(e => !agg.has(e.card_id + '|' + e.finish)).map(e => e.id);
      for (const c of chunk(drop, 200)) await must(sb.from('collection').delete().in('id', c));
    }

    const cards = found.reduce((s, i) => s + i.qty, 0);
    importStatus(`Imported ${cards} card${cards === 1 ? '' : 's'} (${agg.size} unique)` + (missing.length ? `, ${missing.length} not found` : '') + '.');
    $('#importResult').innerHTML = missing.length
      ? `<h3>Couldn't find ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'}</h3><ul>${missing.map(i => `<li>${esc(i.line)}</li>`).join('')}</ul>` : '';
    $('#paste').value = '';
    state.cards.clear();
    await loadAll();
  } catch (e) {
    console.error(e);
    importStatus((e.message || 'Something went wrong') + (e instanceof TypeError ? ' (check your internet connection)' : ''), true);
  } finally { setBusy(false); progress(null); }
}

// ---------- refresh prices now ----------
$('#refreshBtn').addEventListener('click', async () => {
  if (state.busy || !state.entries.length) return;
  setBusy(true); $('#refreshBtn').textContent = 'Refreshing…';
  try {
    const ids = [...new Set(state.entries.flatMap(e => { const c = state.cards.get(e.card_id); return [e.card_id, c && c.alt_id]; }).filter(Boolean))];
    const res = await sf.collection(ids.map(id => ({ id })), f => $('#refreshBtn').textContent = `Refreshing… ${Math.round(f * 100)}%`);
    const cards = [...res.values()], today = todayUTC();
    await upsertChunks('cards', cards.map(cardRow), 'id');
    await upsertChunks('price_history', cards.map(c => priceRow(c, today)), 'card_id,date');

    // owned printings that now need an alternate price source
    const owned = new Set(state.entries.map(e => e.card_id));
    const needs = cards.filter(c => owned.has(c.id) && !hasAllPrices(c.prices) && !(state.cards.get(c.id) || {}).alt_id);
    if (needs.length) {
      const alts = await findAlts(needs, sf);
      if (alts.size) {
        await upsertChunks('cards', [...alts.values()].map(a => cardRow(a.alt)), 'id');
        await upsertChunks('price_history', [...alts.values()].map(a => priceRow(a.alt, today)), 'card_id,date');
        for (const [id, a] of alts) await must(sb.from('cards').update({ alt_id: a.alt.id, alt_note: a.note }).eq('id', id));
      }
    }
    state.cards.clear();
    await loadAll();
    toast('Prices refreshed from Scryfall.');
  } catch (e) { console.error(e); toast('Refresh failed: ' + (e.message || e)); }
  finally { setBusy(false); $('#refreshBtn').textContent = 'Refresh prices'; }
});

// ---------- tabs ----------
const VIEWS = ['collection', 'sets', 'movers'];
function setView(v) {
  if (!VIEWS.includes(v)) v = 'collection';
  state.view = v;
  for (const t of document.querySelectorAll('.tab')) { const on = t.dataset.view === v; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); }
  for (const x of VIEWS) $('#view-' + x).hidden = x !== v;
  pv.style.display = 'none';
  if (state.user && state.entries.length) render({ table: true, chart: true });
}
addEventListener('hashchange', () => setView(location.hash.slice(1)));
setView(location.hash.slice(1));

// ---------- sets view ----------
const cnSort = (a, b) => (parseFloat(a.c.collector_number) || 0) - (parseFloat(b.c.collector_number) || 0) || String(a.c.collector_number).localeCompare(String(b.c.collector_number));
const smallImg = url => (url || '').replace('/normal/', '/small/');
let setGroups = new Map();

function renderSets() {
  const f = state.setFilter.trim().toLowerCase(), groups = new Map();
  for (const r of rows()) {
    const code = r.c.set_code || '?', name = r.c.set_name || code.toUpperCase();
    if (f && !name.toLowerCase().includes(f) && !code.includes(f) && !r.c.name.toLowerCase().includes(f)) continue;
    let g = groups.get(code);
    if (!g) groups.set(code, g = { code, name, rows: [], qty: 0, value: 0, delta: 0, hasDelta: false });
    g.rows.push(r); g.qty += r.e.quantity; g.value += r.total || 0;
    if (r.delta != null) { g.delta += r.delta * r.e.quantity; g.hasDelta = true; }
  }
  const sorters = { value: (a, b) => b.value - a.value, cards: (a, b) => b.qty - a.qty, name: (a, b) => a.name.localeCompare(b.name), code: (a, b) => a.code.localeCompare(b.code) };
  const list = [...groups.values()].sort((a, b) => sorters[state.setSort](a, b) || a.name.localeCompare(b.name));
  setGroups = groups;
  $('#setSort').value = state.setSort;
  $('#setExpand').textContent = list.length && list.every(g => state.openSets.has(g.code)) ? 'Collapse all' : 'Expand all';
  $('#setList').innerHTML = list.map(g => {
    const open = state.openSets.has(g.code) || (f && list.length <= 3);
    const d = g.hasDelta && Math.abs(g.delta) >= 0.005 ? `<span class="sdelta ${g.delta > 0 ? 'up' : 'down'}">${signed(g.delta)}</span>` : '';
    return `<details class="set" data-code="${esc(g.code)}"${open ? ' open' : ''}>
      <summary>
        <img class="seticon" src="https://svgs.scryfall.io/sets/${esc(g.code)}.svg" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="sname">${esc(g.name)}</span><span class="scode">${esc(g.code.toUpperCase())}</span>
        <span class="spacer"></span>
        <span class="smeta">${g.rows.length} printing${g.rows.length === 1 ? '' : 's'} · ${g.qty} card${g.qty === 1 ? '' : 's'}</span>
        ${d}<span class="sval">${money(g.value)}</span>
      </summary>
      <div class="sbody">${open ? setTable(g) : ''}</div>
    </details>`;
  }).join('') || `<div class="empty">${state.entries.length ? 'No sets match that filter.' : 'Your collection is empty.'}</div>`;
}

function setTable(g) {
  return `<table class="mini"><thead><tr><th class="num">Qty</th><th>Card</th><th>#</th><th>Finish</th><th class="num">Each</th><th class="num">Change</th><th class="num">Total</th></tr></thead><tbody>` +
    [...g.rows].sort(cnSort).map(r => `<tr data-img="${esc(r.c.image_url || '')}">
      <td class="num">${r.e.quantity}</td>
      <td class="name"><span class="dot r-${esc(r.c.rarity)}"></span><a href="${esc(r.c.scryfall_uri)}" target="_blank" rel="noopener">${esc(r.c.name)}</a>${r.now && r.now.via ? `<span class="fb via" title="No price for this printing; using ${esc(r.c.alt_note || 'another printing')}">(via ${esc(r.now.via.set_code.toUpperCase())} #${esc(r.now.via.collector_number)})</span>` : ''}</td>
      <td class="muted">${esc(r.c.collector_number)}</td>
      <td>${r.e.finish === 'nonfoil' ? '<span class="badge">normal</span>' : `<span class="badge ${r.e.finish}">${r.e.finish}</span>`}</td>
      <td class="num">${money(r.unit)}</td>
      <td class="num">${r.delta == null || Math.abs(r.delta) < 0.005 ? '<span class="muted">—</span>' : `<span class="delta ${r.delta > 0 ? 'up' : 'down'}">${signed(r.delta)}</span>`}</td>
      <td class="num"><strong>${money(r.total)}</strong></td></tr>`).join('') + '</tbody></table>';
}

$('#setList').addEventListener('toggle', e => {          // 'toggle' doesn't bubble, so listen in the capture phase
  const d = e.target; if (!d.matches || !d.matches('details.set')) return;
  const code = d.dataset.code;
  if (d.open) { state.openSets.add(code); const body = d.querySelector('.sbody'); if (!body.innerHTML.trim()) body.innerHTML = setTable(setGroups.get(code)); }
  else state.openSets.delete(code);
  $('#setExpand').textContent = [...setGroups.keys()].every(c => state.openSets.has(c)) ? 'Collapse all' : 'Expand all';
}, true);
let setFilterTimer;
$('#setFilter').addEventListener('input', e => { clearTimeout(setFilterTimer); setFilterTimer = setTimeout(() => { state.setFilter = e.target.value; renderSets(); }, 120); });
$('#setSort').addEventListener('change', e => { state.setSort = e.target.value; renderSets(); });
$('#setExpand').addEventListener('click', () => {
  const all = [...setGroups.keys()].every(c => state.openSets.has(c));
  if (all) state.openSets.clear(); else for (const c of setGroups.keys()) state.openSets.add(c);
  renderSets();
});

// ---------- movers view ----------
try { Object.assign(state.mv, JSON.parse(localStorage.getItem('mcs.movers') || '{}')); } catch (e) {}
async function loadPastFor(p) {
  const today = todayUTC(), first = () => must(sb.from('price_history').select('date').lt('date', today).order('date', { ascending: true }).limit(1));
  let d = p === 'all' ? await first() : await must(sb.from('price_history').select('date').lte('date', daysAgo(+p)).order('date', { ascending: false }).limit(1));
  if (!d.length && p !== 'all') d = await first();
  if (!d.length) return { date: null, map: new Map() };
  const date = d[0].date, map = new Map();
  const ids = [...new Set(state.entries.flatMap(e => { const c = state.cards.get(e.card_id); return [e.card_id, c && c.alt_id]; }).filter(Boolean))];
  await pmap(chunk(ids, 120), async c => {
    for (const r of await must(sb.from('price_history').select('card_id,usd,usd_foil,usd_etched,eur,eur_foil,eur_etched').eq('date', date).in('card_id', c))) map.set(r.card_id, r);
  });
  return { date, map };
}

async function renderMovers() {
  const mv = state.mv;
  for (const [id, key] of [['#mvPeriod', 'period'], ['#mvMode', 'mode'], ['#mvUnit', 'unit']])
    for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === mv[key]);
  $('#mvMode').classList.toggle('disabled', mv.unit === 'pct');
  const p = mv.period;
  let past = p === '7' && state.pastDate ? { date: state.pastDate, map: state.past } : state.pastByPeriod[p];
  if (!past) {
    $('#mvNote').textContent = 'Loading price history…';
    try { past = state.pastByPeriod[p] = await loadPastFor(p); }
    catch (e) { $('#mvNote').textContent = 'Could not load price history: ' + (e.message || e); return; }
    if (state.view !== 'movers' || state.mv.period !== p) return;
  }
  const empty = msg => { $('#mvUp').innerHTML = $('#mvDown').innerHTML = `<li class="empty">${msg}</li>`; $('#mvUpCount').textContent = $('#mvDownCount').textContent = ''; };
  if (!past.date) { $('#mvNote').textContent = ''; empty('Price changes show up here once the daily update has run on two different days.'); return; }

  const items = [];
  for (const e of state.entries) {
    const c = state.cards.get(e.card_id); if (!c) continue;
    const now = unitPrice(e), then = unitPrice(e, past.map), d = diff(now, then);
    if (d == null) continue;
    items.push({ e, c, now: now.v, then: then.v, d, pct: then.v > 0 ? d / then.v : null });
  }
  const holding = mv.mode === 'holding' && mv.unit !== 'pct';
  const metric = it => mv.unit === 'pct' ? it.pct : holding ? it.d * it.e.quantity : it.d;
  const valid = items.filter(it => metric(it) != null && Math.abs(it.d) >= 0.005);
  const ups = valid.filter(it => metric(it) > 0).sort((a, b) => metric(b) - metric(a));
  const downs = valid.filter(it => metric(it) < 0).sort((a, b) => metric(a) - metric(b));
  const days = Math.round((Date.parse(todayUTC()) - Date.parse(past.date)) / 864e5);
  $('#mvNote').textContent = `Compared with prices on ${fmtDate(past.date)} (${days} day${days === 1 ? '' : 's'} ago). ${valid.length} of ${state.entries.length} printings changed.`;
  const pct = v => v == null ? '' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(1) + '%';
  const li = (it, i) => {
    const q = holding ? it.e.quantity : 1, up = it.d > 0;
    const main = mv.unit === 'pct' ? pct(it.pct) : signed(it.d * q), second = mv.unit === 'pct' ? signed(it.d * q) : pct(it.pct);
    return `<li data-img="${esc(it.c.image_url || '')}">
      <span class="rank">${i + 1}</span>
      <img class="thumb" src="${esc(smallImg(it.c.image_url))}" alt="" loading="lazy">
      <span class="mvname"><a href="${esc(it.c.scryfall_uri)}" target="_blank" rel="noopener">${esc(it.c.name)}</a>
        <span class="mvsub">${esc((it.c.set_code || '').toUpperCase())} #${esc(it.c.collector_number)}${it.e.finish !== 'nonfoil' ? ' · ' + it.e.finish : ''}${holding && q > 1 ? ' · ×' + q : ''}</span></span>
      <span class="mvprice"><span class="chg ${up ? 'up' : 'down'}">${main}</span><span class="from">${money(it.then * q)} → ${money(it.now * q)} · ${second}</span></span>
    </li>`;
  };
  $('#mvUp').innerHTML = ups.slice(0, 25).map(li).join('') || '<li class="empty">No price rises in this period.</li>';
  $('#mvDown').innerHTML = downs.slice(0, 25).map(li).join('') || '<li class="empty">No price drops in this period.</li>';
  $('#mvUpCount').textContent = ups.length ? `${ups.length} rose` + (ups.length > 25 ? ', top 25' : '') : '';
  $('#mvDownCount').textContent = downs.length ? `${downs.length} fell` + (downs.length > 25 ? ', top 25' : '') : '';
}
for (const [id, key] of [['#mvPeriod', 'period'], ['#mvMode', 'mode'], ['#mvUnit', 'unit']]) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || state.mv[key] === b.dataset.v) return;
    state.mv[key] = b.dataset.v; savePref('mcs.movers', JSON.stringify(state.mv)); renderMovers();
  });
}

// ---------- change printing ----------
const modal = { entry: null, prints: [], finish: 'nonfoil', busy: false };
const printCache = new Map();   // printings per card, kept for this visit
const FIN_KEY = { nonfoil: '', foil: '_foil', etched: '_etched' };

async function openPrintings(entryId) {
  const entry = state.entries.find(e => e.id === entryId); if (!entry || state.busy) return;
  const card = state.cards.get(entry.card_id);
  Object.assign(modal, { entry, prints: [], finish: entry.finish, busy: false });
  $('#mTitle').textContent = card.name;
  $('#mSub').textContent = `You have ${entry.quantity} × ${(card.set_code || '').toUpperCase()} #${card.collector_number} (${entry.finish === 'nonfoil' ? 'normal' : entry.finish}). Pick the printing you actually own.`;
  $('#mFilter').value = '';
  $('#mList').innerHTML = '';
  $('#mStatus').textContent = 'Loading printings from Scryfall…'; $('#mStatus').className = 'status';
  renderFinishSeg();
  $('#modal').hidden = false; pv.style.display = 'none';
  try {
    const key = card.oracle_id || card.name;
    if (printCache.has(key)) modal.prints = printCache.get(key);
    else {
      modal.prints = await sf.printings(card, page => {         // show results as each page arrives
        if (modal.entry !== entry) return;
        modal.prints = page; $('#mStatus').textContent = `Loading… ${page.length} printings so far`; renderPrints();
      });
      printCache.set(key, modal.prints);
    }
    if (modal.entry !== entry) return;               // closed / reopened meanwhile
    if (!modal.prints.length) { $('#mStatus').textContent = "Scryfall didn't return any printings for this card."; return; }
    $('#mStatus').textContent = `${modal.prints.length} printing${modal.prints.length === 1 ? '' : 's'}. Click one to switch to it.`;
    renderPrints();
    $('#mFilter').focus();
  } catch (e) { $('#mStatus').textContent = 'Could not load printings: ' + (e.message || e); $('#mStatus').className = 'status err'; }
}

function renderFinishSeg() {
  for (const b of $('#mFinish').children) b.classList.toggle('on', b.dataset.f === modal.finish);
}

function renderPrints() {
  const f = $('#mFilter').value.trim().toLowerCase(), cur = modal.entry && modal.entry.card_id;
  const conv = v => state.currency === 'AUD' ? v * (state.rate || 0) : v;
  const b = base();
  const html = modal.prints.map((p, i) => {
    const year = (p.released_at || '').slice(0, 4);
    if (f && !`${p.set} ${p.set_name} ${year} ${p.collector_number}`.toLowerCase().includes(f)) return '';
    const fins = p.finishes || ['nonfoil'];
    const price = Object.entries(FIN_KEY).filter(([fin]) => fins.includes(fin)).map(([fin, suf]) => {
      const v = p.prices && p.prices[b + suf];
      return `${fin === 'nonfoil' ? 'normal' : fin} ${v != null ? money(conv(+v)) : '—'}`;
    }).join(' · ');
    const img = (p.image_uris && p.image_uris.small) || (p.card_faces && p.card_faces[0].image_uris && p.card_faces[0].image_uris.small) || '';
    return `<button class="print${p.id === cur ? ' current' : ''}${fins.includes(modal.finish) ? '' : ' nofinish'}" data-i="${i}" title="${esc(p.set_name)} #${esc(p.collector_number)}">
      <img loading="lazy" src="${esc(img)}" alt="">
      <span class="pm"><strong>${esc(p.set.toUpperCase())} #${esc(p.collector_number)}</strong>
        <span class="sn">${esc(p.set_name)}${year ? ' · ' + year : ''}</span>
        <span class="pr">${price}</span>
        ${p.id === cur ? '<span class="tag">current</span>' : ''}${fins.includes(modal.finish) ? '' : `<span class="tag">no ${modal.finish} version</span>`}</span>
    </button>`;
  }).join('');
  $('#mList').innerHTML = html || '<div class="empty">No printings match that filter.</div>';
}

function closeModal() { $('#modal').hidden = true; modal.entry = null; }
$('#mClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !modal.busy) closeModal(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden && !modal.busy) closeModal(); });
$('#mFilter').addEventListener('input', renderPrints);
$('#mFinish').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  modal.finish = b.dataset.f; renderFinishSeg(); renderPrints();
});
$('#mList').addEventListener('click', async e => {
  const b = e.target.closest('.print'); if (!b || modal.busy) return;
  const p = modal.prints[+b.dataset.i], entry = modal.entry;
  const fins = p.finishes || ['nonfoil'];
  const finish = fins.includes(modal.finish) ? modal.finish : fins[0];
  if (p.id === entry.card_id && finish === entry.finish) { closeModal(); return; }
  modal.busy = true; $('#mStatus').className = 'status'; $('#mStatus').textContent = 'Saving…';
  try {
    await changePrinting(entry, p, finish);
    closeModal();
    toast(`Switched to ${p.set.toUpperCase()} #${p.collector_number}` + (finish !== modal.finish ? ` (${finish}: that printing has no ${modal.finish} version)` : '') + '.');
  } catch (err) {
    console.error(err);
    $('#mStatus').textContent = 'Save failed: ' + (err.message || err); $('#mStatus').className = 'status err';
  } finally { modal.busy = false; }
});

async function changePrinting(entry, p, finish) {
  const today = todayUTC();
  const row = { ...cardRow(p), alt_id: null, alt_note: null };
  const cardRows = [], priceRows = [priceRow(p, today)];
  if (!hasAllPrices(p.prices)) {                          // e.g. a List card: price it from the original printing
    const a = (await findAlts([p], sf)).get(p.id);
    if (a && a.alt.id !== p.id) {
      cardRows.push({ ...cardRow(a.alt), alt_id: null, alt_note: null }); priceRows.push(priceRow(a.alt, today));
      row.alt_id = a.alt.id; row.alt_note = a.note;
    }
  }
  cardRows.push(row);
  await must(sb.from('cards').upsert(cardRows, { onConflict: 'id' }));   // one request; alternate printing first

  // already own that printing + finish? merge the quantities into one row
  const dupe = state.entries.find(e => e.id !== entry.id && e.card_id === p.id && e.finish === finish);
  const saves = [must(sb.from('price_history').upsert(priceRows, { onConflict: 'card_id,date' }))];
  if (dupe) {
    saves.push(must(sb.from('collection').update({ quantity: dupe.quantity + entry.quantity }).eq('id', dupe.id)));
    saves.push(must(sb.from('collection').delete().eq('id', entry.id)));
  } else {
    saves.push(must(sb.from('collection').update({ card_id: p.id, finish }).eq('id', entry.id)));
  }
  await Promise.all(saves);

  // update what's on screen without reloading everything
  for (const r of cardRows) state.cards.set(r.id, r);
  if (dupe) { dupe.quantity += entry.quantity; state.entries.splice(state.entries.indexOf(entry), 1); }
  else { entry.card_id = p.id; entry.finish = finish; }
  render({ stats: true, table: true });
}

// ---------- export ----------
function toCSV() {
  const q = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const cur = state.currency;
  const out = [['Quantity', 'Name', 'Set Code', 'Set Name', 'Collector Number', 'Finish', `Unit Price (${cur})`, `Total (${cur})`, 'Scryfall ID', 'Note'].join(',')];
  for (const r of rows()) {
    const { e, c, now } = r;
    out.push([e.quantity, c.name, (c.set_code || '').toUpperCase(), c.set_name, c.collector_number, e.finish,
      r.unit == null ? '' : r.unit.toFixed(2), r.total == null ? '' : r.total.toFixed(2), c.id,
      r.unit == null ? 'no price' : [now.via ? 'price from ' + (c.alt_note || now.via.set_code.toUpperCase() + ' #' + now.via.collector_number) : '',
        now.usedFinish !== e.finish ? now.usedFinish + ' price used' : ''].filter(Boolean).join('; ')].map(q).join(','));
  }
  return out.join('\n');
}
$('#exportBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCSV()], { type: 'text/csv' }));
  a.download = 'mtg-collection-' + todayUTC() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('#copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(toCSV()); toast('Copied collection as CSV.'); }
  catch (e) { toast("Couldn't copy to clipboard."); }
});
