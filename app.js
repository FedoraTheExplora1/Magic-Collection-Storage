import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { parseInput, makeScryfall, resolveItems, findAlts, cardRow, priceRow, priceFrom, hasAllPrices, todayUTC } from './js/core.js';

const $ = s => document.querySelector(s);
const sf = makeScryfall();
const state = {
  user: null, entries: [], cards: new Map(), past: new Map(), pastDate: null, snapshots: [],
  rate: null, rateDate: null, currency: 'AUD', useAlt: true,
  sortKey: 'total', sortDir: -1, filter: '', busy: false
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
  for (const c of chunk(need, 120)) {
    for (const row of await must(sb.from('cards').select('*').in('id', c))) state.cards.set(row.id, row);
  }
}
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function loadRate() {
  const rows = await must(sb.from('fx_rates').select('*').order('date', { ascending: false }).limit(1));
  if (rows.length) { state.rate = +rows[0].aud_per_usd; state.rateDate = rows[0].date; return; }
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
  for (const c of chunk(ids, 120)) {
    const rows = await must(sb.from('price_history').select('card_id,usd,usd_foil,usd_etched,eur,eur_foil,eur_etched').eq('date', state.pastDate).in('card_id', c));
    for (const r of rows) state.past.set(r.card_id, r);
  }
}

async function loadAll() {
  $('#lastUpdated').textContent = 'Loading…';
  try {
    state.entries = await fetchAll(() => sb.from('collection').select('id,card_id,finish,quantity,added_at').order('id'));
    await loadCards(state.entries.map(e => e.card_id));
    await loadCards([...state.cards.values()].map(c => c.alt_id));
    await Promise.all([
      loadRate(),
      loadPast(),
      fetchAll(() => sb.from('value_snapshots').select('date,value_usd,value_eur,value_aud,card_count').order('date')).then(s => state.snapshots = s)
    ]);
    render();
  } catch (e) {
    console.error(e);
    $('#lastUpdated').innerHTML = `<span class="down">Couldn't load your collection: ${esc(e.message || e)}</span>`;
  }
}

// ---------- pricing ----------
const base = () => state.currency === 'EUR' ? 'eur' : 'usd';
function unitPrice(e, past = false) {
  const card = state.cards.get(e.card_id); if (!card) return null;
  const src = past ? state.past.get(e.card_id) : card.prices;
  let r = priceFrom(src, e.finish, base()), via = null;
  if (!r && state.useAlt && card.alt_id) {
    const alt = state.cards.get(card.alt_id);
    r = priceFrom(past ? state.past.get(card.alt_id) : alt && alt.prices, e.finish, base());
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

function rows() {
  return state.entries.map(e => {
    const c = state.cards.get(e.card_id), now = unitPrice(e), then = unitPrice(e, true);
    return { e, c, now, unit: now ? now.v : null, total: now ? now.v * e.quantity : null,
      // only compare like with like (same finish, same printing) so a missing foil price last week doesn't fake a jump
      delta: now && then && now.usedFinish === then.usedFinish && (now.via && now.via.id) === (then.via && then.via.id) ? now.v - then.v : null };
  }).filter(r => r.c);
}

function render() {
  $('#currency').value = state.currency;
  $('#useAlt').checked = state.useAlt;
  $('#rateText').textContent = state.rate ? `1 USD = ${state.rate.toFixed(4)} AUD${state.rateDate ? ', ' + state.rateDate : ''}` : '…';
  const updated = [...state.cards.values()].reduce((m, c) => c.updated_at > m ? c.updated_at : m, '');
  $('#lastUpdated').textContent = updated ? 'Prices last updated ' + new Date(updated).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : 'No cards yet';

  const all = rows();
  // stats
  const total = all.reduce((s, r) => s + (r.total || 0), 0);
  $('#sTotal').textContent = money(total);
  $('#sCards').textContent = state.entries.reduce((s, e) => s + e.quantity, 0).toLocaleString();
  $('#sUnique').textContent = state.entries.length.toLocaleString();
  if (state.pastDate) {
    const both = all.filter(r => r.delta != null);
    const d = both.reduce((s, r) => s + r.delta * r.e.quantity, 0);
    const prev = both.reduce((s, r) => s + (r.unit - r.delta) * r.e.quantity, 0);
    $('#sChangeLabel').textContent = 'Change since ' + fmtDate(state.pastDate);
    $('#sChange').innerHTML = `<span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${signed(d)}</span>` +
      (prev ? ` <span class="note">${(d / prev * 100).toFixed(1)}%</span>` : '');
  } else { $('#sChangeLabel').textContent = 'Change'; $('#sChange').innerHTML = '<span class="note">after first daily update</span>'; }

  // table
  $('#thead').innerHTML = COLS.map(([k, label, cls]) =>
    `<th data-k="${k}" class="${cls}">${label}${k && state.sortKey === k ? ' <span class="arrow">' + (state.sortDir < 0 ? '▼' : '▲') + '</span>' : ''}</th>`).join('');
  const f = state.filter.toLowerCase();
  let list = f ? all.filter(r => (r.c.name + ' ' + r.c.set_code + ' ' + r.c.set_name).toLowerCase().includes(f)) : all;
  const k = state.sortKey, dir = state.sortDir;
  const val = r => ({ qty: r.e.quantity, name: r.c.name, set: r.c.set_name || '', cn: parseFloat(r.c.collector_number) || 0,
    finish: r.e.finish, unit: r.unit ?? -Infinity, delta: r.delta ?? -Infinity, total: r.total ?? -Infinity })[k];
  list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.c.name.localeCompare(b.c.name); });

  $('#tbody').innerHTML = list.map(r => {
    const { e, c, now } = r;
    const notes = (now && now.via ? `<span class="fb via" title="This printing has no price; using the ${esc(c.alt_note || 'printing ' + now.via.set_code.toUpperCase() + ' #' + now.via.collector_number)}">(via ${esc(now.via.set_code.toUpperCase())} #${esc(now.via.collector_number)})</span>` : '') +
      (now && now.usedFinish !== e.finish ? `<span class="fb" title="No ${e.finish} price listed, showing ${now.usedFinish} price">(${now.usedFinish} price)</span>` : '');
    const delta = r.delta == null || Math.abs(r.delta) < 0.005 ? '<span class="muted">—</span>'
      : `<span class="delta ${r.delta > 0 ? 'up' : 'down'}">${signed(r.delta)}</span>`;
    return `<tr data-id="${e.id}" data-img="${esc(c.image_url || '')}">
      <td class="num"><input class="qty" type="number" min="0" value="${e.quantity}" title="Change quantity (0 removes it)"></td>
      <td class="name"><span class="dot r-${esc(c.rarity)}"></span><a href="${esc(c.scryfall_uri)}" target="_blank" rel="noopener">${esc(c.name)}</a></td>
      <td>${esc((c.set_code || '').toUpperCase())} <span class="muted">${esc(c.set_name)}</span></td>
      <td class="muted">${esc(c.collector_number)}</td>
      <td>${e.finish === 'nonfoil' ? '<span class="badge">normal</span>' : `<span class="badge ${e.finish}">${e.finish}</span>`}</td>
      <td class="num">${money(r.unit)}${notes}</td>
      <td class="num">${delta}</td>
      <td class="num"><strong>${money(r.total)}</strong></td>
      <td><button class="del" title="Remove from collection">×</button></td>
    </tr>`;
  }).join('') || (state.entries.length ? '<tr><td colspan="9" class="muted">No matches for that filter.</td></tr>' : '');
  $('#emptyMsg').hidden = state.entries.length > 0;
  $('.tablewrap').hidden = state.entries.length === 0;
  if (!state.entries.length) $('#importPanel').open = true;

  renderChart();
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
  const pad = (hi - lo) * 0.12; lo = Math.max(0, lo - pad); hi += pad;
  const x = i => pl + (W - pl - pr) * i / (pts.length - 1), y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const grid = [0, 1, 2, 3].map(i => { const v = lo + (hi - lo) * i / 3, yy = y(v).toFixed(1);
    return `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="var(--line)"/>
      <text x="${pl - 8}" y="${yy}" fill="var(--muted)" font-size="11" text-anchor="end" dominant-baseline="middle">${money(v)}</text>`; }).join('');
  const idx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
  const xl = idx.map(i => `<text x="${x(i)}" y="${H - 6}" fill="var(--muted)" font-size="11" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${fmtDate(pts[i].d)}</text>`).join('');
  el.innerHTML = `<svg width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9a441" stop-opacity=".28"/><stop offset="1" stop-color="#d9a441" stop-opacity="0"/></linearGradient></defs>
    ${grid}${xl}
    <path d="${line}L${x(pts.length - 1)},${H - pb}L${x(0)},${H - pb}Z" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    <circle id="hdot" r="4" fill="var(--accent2)" stroke="var(--bg)" stroke-width="2" style="display:none"/>
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
  render();
});
$('#filter').addEventListener('input', e => { state.filter = e.target.value; render(); });
$('#currency').addEventListener('change', e => { state.currency = e.target.value; savePref('mcs.currency', state.currency); render(); });
$('#useAlt').addEventListener('change', e => { state.useAlt = e.target.checked; savePref('mcs.useAlt', state.useAlt ? '1' : '0'); render(); });

$('#tbody').addEventListener('change', async e => {
  if (!e.target.classList.contains('qty')) return;
  const id = +e.target.closest('tr').dataset.id, q = parseInt(e.target.value, 10);
  const entry = state.entries.find(x => x.id === id); if (!entry || isNaN(q)) return;
  try {
    if (q <= 0) {
      if (!confirm(`Remove ${state.cards.get(entry.card_id).name} from your collection?`)) { e.target.value = entry.quantity; return; }
      await must(sb.from('collection').delete().eq('id', id));
      state.entries = state.entries.filter(x => x.id !== id);
    } else {
      await must(sb.from('collection').update({ quantity: q }).eq('id', id));
      entry.quantity = q;
    }
    render();
  } catch (err) { toast('Save failed: ' + err.message); e.target.value = entry.quantity; }
});
$('#tbody').addEventListener('click', async e => {
  if (!e.target.classList.contains('del')) return;
  const id = +e.target.closest('tr').dataset.id, entry = state.entries.find(x => x.id === id);
  if (!entry || !confirm(`Remove ${state.cards.get(entry.card_id).name} from your collection?`)) return;
  try {
    await must(sb.from('collection').delete().eq('id', id));
    state.entries = state.entries.filter(x => x.id !== id); render();
  } catch (err) { toast('Delete failed: ' + err.message); }
});

// hover preview
const pv = $('#preview');
$('#tbody').addEventListener('mousemove', e => {
  const tr = e.target.closest('tr'), src = tr && tr.dataset.img;
  if (!src || e.target.closest('input,button')) { pv.style.display = 'none'; return; }
  if (pv.getAttribute('src') !== src) pv.src = src;
  const w = 244, h = 340;
  let x = e.clientX + 24, y = e.clientY - h / 2;
  if (x + w > innerWidth - 8) x = e.clientX - w - 24;
  y = Math.max(8, Math.min(y, innerHeight - h - 8));
  pv.style.left = x + 'px'; pv.style.top = y + 'px'; pv.style.display = 'block';
});
$('#tbody').addEventListener('mouseleave', () => pv.style.display = 'none');

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
