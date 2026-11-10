// Daily price update. Run by .github/workflows/update-prices.yml (or locally: see README).
// Needs env vars SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the secret key — never put it in the website).
import { createClient } from '@supabase/supabase-js';
import { makeScryfall, findAlts, cardRow, priceRow, priceFrom, hasAllPrices, todayUTC } from '../js/core.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Scryfall asks server-side apps to send a descriptive User-Agent
const sf = makeScryfall({ headers: { Accept: 'application/json', 'User-Agent': 'MagicCollectionStorage/1.0 (personal collection tracker)' } });

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
async function fetchAll(build, page = 1000) {
  let out = [];
  for (let from = 0; ; from += page) {
    const data = await must(build().range(from, from + page - 1));
    out = out.concat(data);
    if (data.length < page) return out;
  }
}
async function upsert(table, rows, onConflict) {
  for (const c of chunk(rows, 500)) await must(sb.from(table).upsert(c, { onConflict }));
}

async function usdToAud() {
  const sources = [
    ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD', j => j.rates?.AUD],
    ['https://api.frankfurter.app/latest?from=USD&to=AUD', j => j.rates?.AUD],
    ['https://open.er-api.com/v6/latest/USD', j => j.rates?.AUD]
  ];
  for (const [url, pick] of sources) {
    try { const r = await fetch(url); if (r.ok) { const v = pick(await r.json()); if (v) return +v; } } catch (e) {}
  }
  return null;
}

async function main() {
  const today = todayUTC();
  const t0 = Date.now();

  const collection = await fetchAll(() => sb.from('collection').select('user_id,card_id,finish,quantity').order('id'));
  const ownedIds = [...new Set(collection.map(c => c.card_id))];
  console.log(`${collection.length} collection rows, ${ownedIds.length} unique printings`);
  if (!ownedIds.length) { console.log('Nothing to update.'); return; }

  const cards = new Map();
  for (const c of chunk(ownedIds, 150)) for (const row of await must(sb.from('cards').select('*').in('id', c))) cards.set(row.id, row);
  const altIds = [...new Set([...cards.values()].map(c => c.alt_id).filter(id => id && !cards.has(id)))];
  for (const c of chunk(altIds, 150)) for (const row of await must(sb.from('cards').select('*').in('id', c))) cards.set(row.id, row);

  // 1. today's prices from Scryfall for every owned printing + their alternates
  const ids = [...cards.keys()];
  const res = await sf.collection(ids.map(id => ({ id })), f => process.stdout.write(`\rScryfall: ${Math.round(f * 100)}%`));
  console.log();
  const fresh = [...res.values()];
  await upsert('cards', fresh.map(cardRow), 'id');
  await upsert('price_history', fresh.map(c => priceRow(c, today)), 'card_id,date');
  for (const c of fresh) { const row = cards.get(c.id); Object.assign(row, { prices: cardRow(c).prices }); }
  console.log(`Updated prices for ${fresh.length}/${ids.length} printings`);

  // 2. owned printings with no price and no alternate yet -> find one (List cards -> original printing)
  const needs = ownedIds.map(id => cards.get(id)).filter(c => c && !c.alt_id && !hasAllPrices(c.prices));
  if (needs.length) {
    const alts = await findAlts(needs, sf, s => console.log(s));
    if (alts.size) {
      await upsert('cards', [...alts.values()].map(a => cardRow(a.alt)), 'id');
      await upsert('price_history', [...alts.values()].map(a => priceRow(a.alt, today)), 'card_id,date');
      for (const [id, a] of alts) {
        await must(sb.from('cards').update({ alt_id: a.alt.id, alt_note: a.note }).eq('id', id));
        cards.set(a.alt.id, { ...cardRow(a.alt) });
        cards.get(id).alt_id = a.alt.id;
      }
    }
    console.log(`Found alternate printings for ${alts.size}/${needs.length} unpriced cards`);
  }

  // 3. exchange rate
  let rate = await usdToAud();
  if (rate) await upsert('fx_rates', [{ date: today, aud_per_usd: rate }], 'date');
  else {
    const last = await must(sb.from('fx_rates').select('aud_per_usd').order('date', { ascending: false }).limit(1));
    rate = last.length ? +last[0].aud_per_usd : null;
    console.warn('Could not fetch exchange rate; using last known:', rate);
  }

  // 4. value snapshot per user (uses the alternate printing when a card has no price)
  const users = new Map();
  for (const e of collection) {
    const u = users.get(e.user_id) || { usd: 0, eur: 0, count: 0 };
    const card = cards.get(e.card_id), alt = card && card.alt_id ? cards.get(card.alt_id) : null;
    for (const b of ['usd', 'eur']) {
      const r = priceFrom(card && card.prices, e.finish, b) || priceFrom(alt && alt.prices, e.finish, b);
      if (r) u[b] += r.v * e.quantity;
    }
    u.count += e.quantity;
    users.set(e.user_id, u);
  }
  await upsert('value_snapshots', [...users].map(([user_id, u]) => ({
    user_id, date: today, card_count: u.count,
    value_usd: +u.usd.toFixed(2), value_eur: +u.eur.toFixed(2), value_aud: rate ? +(u.usd * rate).toFixed(2) : null
  })), 'user_id,date');

  console.log(`Saved value snapshots for ${users.size} user(s). Done in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
}

main().catch(e => { console.error(e); process.exit(1); });
