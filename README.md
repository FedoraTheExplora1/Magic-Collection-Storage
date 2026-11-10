# Magic Collection Storage

A personal Magic: The Gathering collection tracker:

- **Import** CSV exports from Moxfield, Archidekt, ManaBox, Deckbox, Dragon Shield or TCGplayer, or paste a list (`4 Lightning Bolt`, `1 Sol Ring (C21) 263 *F*`)
- **Stores your collection** in a free Supabase (Postgres) database, behind a login
- **Daily price updates** from Scryfall via a scheduled GitHub Action, with price history
- **Value over time** chart, a per-card change column, and AUD / USD / EUR pricing
- **List cards** (collector numbers like `DOM-142`) with no price fall back to the original printing's price. Other unpriced cards fall back to the cheapest printing that has a price.
- Edit quantities, remove cards, export the collection to CSV

```
index.html, style.css, app.js   the website (static, hosted on GitHub Pages)
config.js                       your Supabase URL + public key (fill in, step 3)
js/core.js                      shared logic: CSV parsing, Scryfall lookups, pricing
supabase/schema.sql             database tables + security rules (step 2)
scripts/update-prices.js        the daily price job
.github/workflows/              runs the job every morning
```

## Setup (about 20 minutes, all free)

### 1. Create a Supabase project
Sign up at [supabase.com](https://supabase.com) → **New project**. Pick region **Sydney (ap-southeast-2)** and set any database password (you won't need it for this).

### 2. Create the tables
In the project, open **SQL Editor** → **New query**, paste the whole of `supabase/schema.sql`, and click **Run**. You should see "Success. No rows returned".

### 3. Connect the website
Go to **Project Settings → API Keys**. Copy the **Project URL** and the **Publishable key** (on older projects this is the **anon public** key, under "Legacy API keys") into `config.js`:

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_...';   // or the eyJ... anon key
```

The publishable/anon key is meant to be public, because the security rules in the schema stop anyone from reading or changing your collection without signing in. **Never** put the *secret* / *service_role* key in `config.js`.

### 4. Create your login and lock sign-ups
- **Authentication → Users → Add user → Create new user**: enter your email and a password, and tick **Auto Confirm User**.
- **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up", so nobody else can create an account.

### 5. Publish the site with GitHub Pages
Commit and push everything (GitHub Desktop: write a summary → **Commit to main** → **Push origin**). Then on GitHub go to the repo's **Settings → Pages**, set **Source: Deploy from a branch** and **Branch: main / (root)**, and click **Save**. After a minute or so the site is live at:

**https://fedoratheexplora1.github.io/Magic-Collection-Storage/**

(GitHub Pages on a free account needs the repo to be **public**. That's fine here: nothing secret is in the code.)

### 6. Turn on the daily price update
If there's a `move-to-.github-workflows` folder in the repo: create a `.github\workflows` folder, move `update-prices.yml` into it, delete the empty `move-to-.github-workflows` folder, then commit and push.

On GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add two secrets:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the **Secret key** from Project Settings → API Keys (or the legacy **service_role** key) |

Then go to **Actions → Update prices → Run workflow** to run it once now. After that it runs every day at about 7:17am Sydney time.

### 7. Import your cards
Open the site, sign in, expand **Add cards**, and drop in your CSV.

## How it works

- **Importing** happens in your browser. The site sends your card list to Scryfall in batches of 75 (Scryfall's limit), then saves the matched printings and today's prices to Supabase. If a set code or collector number doesn't match, it retries by name, then with a fuzzy name search. Anything still unmatched is listed so you can fix it.
- **The daily job** fetches fresh prices for every printing you own, stores a row per card per day in `price_history`, saves the USD→AUD rate, and records your total collection value in `value_snapshots`. The chart and the change figures are built from these tables.
- **Refresh prices** on the site does the same price fetch immediately, without waiting for the morning job. It doesn't record a value snapshot.
- **AUD** is the US TCGplayer price × that day's exchange rate. Scryfall has no Australian prices, so expect differences from local store prices.

## Good to know

- **GitHub pauses scheduled workflows** in a repo with no commits for 60 days. If that happens you'll get an email. Click the link (or Actions → Update prices → Enable workflow) to turn it back on.
- **Supabase free projects pause** after a week without any activity. The daily job counts as activity, so it should stay awake while the job is running.
- **Storage:** each owned printing adds about 100 bytes of price history per day. 5,000 printings is roughly 180 MB a year, against Supabase's 500 MB free limit. If you get close, delete old rows, for example `delete from price_history where date < now() - interval '1 year';`.

## Running the price job yourself (optional)

```powershell
npm install
$env:SUPABASE_URL="https://abcdefgh.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-secret-key"
npm run update-prices
```

Prices and card images come from [Scryfall](https://scryfall.com). This project isn't affiliated with Scryfall or Wizards of the Coast.
