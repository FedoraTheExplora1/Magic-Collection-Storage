-- Magic Collection Storage — database schema
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to re-run: it only creates things that don't exist yet and refreshes the policies.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per Scryfall printing that anyone owns (shared, not per-user).
create table if not exists public.cards (
  id               uuid primary key,              -- Scryfall card id
  oracle_id        uuid,
  name             text not null,
  set_code         text,
  set_name         text,
  collector_number text,
  rarity           text,
  image_url        text,
  scryfall_uri     text,
  prices           jsonb not null default '{}'::jsonb,   -- latest prices {usd, usd_foil, usd_etched, eur, eur_foil, eur_etched}
  alt_id           uuid references public.cards(id) on delete set null,  -- printing to price from when this one has no price
  alt_note         text,
  updated_at       timestamptz not null default now()
);

-- Your collection: what you own, how many, which finish.
create table if not exists public.collection (
  id        bigint generated always as identity primary key,
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id   uuid not null references public.cards(id),
  finish    text not null default 'nonfoil' check (finish in ('nonfoil', 'foil', 'etched')),
  quantity  integer not null check (quantity > 0),
  added_at  timestamptz not null default now(),
  unique (user_id, card_id, finish)
);
create index if not exists collection_user_idx on public.collection (user_id);
create index if not exists collection_card_idx on public.collection (card_id);

-- Daily price snapshot for every owned printing.
create table if not exists public.price_history (
  card_id    uuid not null references public.cards(id) on delete cascade,
  date       date not null,
  usd        numeric(10,2),
  usd_foil   numeric(10,2),
  usd_etched numeric(10,2),
  eur        numeric(10,2),
  eur_foil   numeric(10,2),
  eur_etched numeric(10,2),
  primary key (card_id, date)
);
create index if not exists price_history_date_idx on public.price_history (date);

-- Daily USD -> AUD exchange rate.
create table if not exists public.fx_rates (
  date        date primary key,
  aud_per_usd numeric(10,5) not null
);

-- Total collection value per user per day (written by the daily job).
create table if not exists public.value_snapshots (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  value_usd  numeric(12,2),
  value_eur  numeric(12,2),
  value_aud  numeric(12,2),
  card_count integer,
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- Row Level Security: signed-in users see shared card/price data,
-- but only ever their own collection and value history.
-- ---------------------------------------------------------------------------
alter table public.cards           enable row level security;
alter table public.collection      enable row level security;
alter table public.price_history   enable row level security;
alter table public.fx_rates        enable row level security;
alter table public.value_snapshots enable row level security;

drop policy if exists "cards: read"   on public.cards;
drop policy if exists "cards: insert" on public.cards;
drop policy if exists "cards: update" on public.cards;
create policy "cards: read"   on public.cards for select to authenticated using (true);
create policy "cards: insert" on public.cards for insert to authenticated with check (true);
create policy "cards: update" on public.cards for update to authenticated using (true) with check (true);

drop policy if exists "prices: read"   on public.price_history;
drop policy if exists "prices: insert" on public.price_history;
drop policy if exists "prices: update" on public.price_history;
create policy "prices: read"   on public.price_history for select to authenticated using (true);
create policy "prices: insert" on public.price_history for insert to authenticated with check (true);
create policy "prices: update" on public.price_history for update to authenticated using (true) with check (true);

drop policy if exists "fx: read" on public.fx_rates;
create policy "fx: read" on public.fx_rates for select to authenticated using (true);

drop policy if exists "collection: own rows" on public.collection;
create policy "collection: own rows" on public.collection for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "snapshots: own rows" on public.value_snapshots;
create policy "snapshots: own rows" on public.value_snapshots for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants (the website uses the "authenticated" role; the daily job uses service_role)
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;
grant select, insert, update          on public.cards, public.price_history to authenticated;
grant select                          on public.fx_rates, public.value_snapshots to authenticated;
grant select, insert, update, delete  on public.collection to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on public.cards, public.collection, public.price_history, public.fx_rates, public.value_snapshots to service_role;
grant usage, select on all sequences in schema public to service_role;
