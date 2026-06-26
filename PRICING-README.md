# WI 64 Self Storage — Live Pricing Setup

This keeps the prices on `units.html` in sync with your storEDGE rental center,
**automatically**.

## How it works

```
scraper.js  ──►  data/availability.json  ──►  js/availability.js  ──►  units.html
 (reads                                         (fills in prices,
  storEDGE)                                       badges, timestamp)
```

`scraper.js` opens the rental center for the **New Richmond facility**
(`c621f5d9-…` — the correct one), reads each unit's starting price and
availability, and writes `data/availability.json`. When `units.html` loads,
`js/availability.js` reads that file and replaces every "—" with the real
"Starting at $X" price (on the cards and in the comparison table) and adds an
**Available / Currently full** badge.

> **Why it must run on your Mac:** storEDGE blocks cloud/datacenter servers
> (returns 503/403), so this can't run in a hosted job — it runs from a real
> computer with a real browser, exactly like your Keewatin scraper.

## One-time setup

```bash
cd "/Users/sswenson/Claude/Self Storage"
npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
```

> **Scrape gently.** storEDGE rate-limits / bot-detects (the "Service
> Unavailable" 503). To stay under the radar the scraper now runs in **stealth
> mode** and opens a **real visible Chrome window** (don't be surprised when a
> browser pops up — let it finish, it closes itself). Run it **no more than once
> or twice a day**. The scraper retries on a 503 and never overwrites good
> prices, so the occasional block is harmless.

## Run it manually

```bash
cd "/Users/sswenson/Claude/Self Storage"
node scraper.js
```

You'll see each unit printed with its price and 🟢/🔴 status, and
`data/availability.json` gets updated. Commit + push to publish:

```bash
git add data/availability.json && git commit -m "Update prices" && git push
```

## Run it automatically ("pulls all the time")

Schedule it with cron so it refreshes on its own. Your Mac must be **awake**
for cron to fire.

```bash
which node          # note the path it prints, e.g. /usr/local/bin/node
crontab -e
```

Add this line (runs twice a day — 7am & 7pm). `HEADLESS=1` runs it hidden so a
window doesn't pop up during scheduled runs. Replace the node path if yours differs:

```
0 7,19 * * * cd "/Users/sswenson/Claude/Self Storage" && HEADLESS=1 /usr/local/bin/node scraper.js >> scraper.log 2>&1 && git add data/availability.json && git commit -m "Auto: update prices" && git push
```

## How to verify it's actually working

1. **Locally:** run `node scraper.js` — it prints prices and a 🟢/🔴 line per unit.
2. **The data file:** open `data/availability.json` — `lastUpdated` should be a
   recent timestamp and each unit should have a real `price`.
3. **The log:** `cat scraper.log` shows each scheduled run.
4. **The live site:** after pushing, `units.html` shows "Starting at $X" and a
   "Prices updated <date>" line under the heading instead of dashes.

## Troubleshooting

- **Dashes still showing:** scraper hasn't run yet, or `price` is still `null`
  in the JSON. Run it manually and check the output.
- **"No unit cards matched":** storEDGE changed its page layout. The scraper
  dumps the raw data to `data/storedge-raw.json` so the selectors can be updated.
- **Cron didn't fire:** the Mac was asleep, or the node path in the cron line is
  wrong (`which node` to confirm).
