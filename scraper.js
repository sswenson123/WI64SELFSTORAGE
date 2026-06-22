/**
 * WI 64 Self Storage — StorEdge Pricing & Availability Scraper
 * ────────────────────────────────────────────────────────────
 * Run from the repo root (the folder that contains units.html):
 *   node scraper.js
 *
 * What it does:
 *   1. Opens the StorEdge rental portal for the New Richmond facility
 *   2. Reads each unit's size, starting price, and availability
 *   3. Writes the result to data/availability.json
 *   4. units.html reads that file (via js/availability.js) and shows
 *      live "Starting at $X" prices + availability badges.
 *
 * First-time setup (run once):
 *   npm install puppeteer
 *
 * Keep it current automatically (runs on YOUR Mac — StorEdge blocks
 * cloud/datacenter IPs, so this must run from a real machine):
 *   crontab -e   then add a line (this one runs at 12am/6am/12pm/6pm):
 *   0 0,6,12,18 * * * cd "/Users/sswenson/Claude/Self Storage" && /usr/local/bin/node scraper.js >> scraper.log 2>&1 && git add data/availability.json && git commit -m "Auto: update prices" && git push
 *
 *   (run `which node` to confirm your node path for the cron line)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ── WI 64 New Richmond facility (the CORRECT one) ────────────────────────────
const COMPANY_ID  = 'ef2375f3-b212-4670-bbc0-be544f6614b6';
const FACILITY_ID = 'c621f5d9-15d0-4cc0-b26f-d4aa778139e7';

const RENT_URL =
  `https://rental-center.storedge.com/?companyId=${COMPANY_ID}` +
  `&facilityId=${FACILITY_ID}#/move-in`;

const OUT_FILE = path.join(__dirname, 'data', 'availability.json');

// Map ANY size StorEdge reports (either dimension order) → our site key.
// We key off the non-10 dimension so 10x14 / 14x10 both resolve to "10x14".
function normaliseKey(sizeStr) {
  if (!sizeStr) return null;
  const nums = (sizeStr.match(/\d+/g) || []).map(Number);
  if (nums.length < 2) return null;
  const set = new Set(nums);
  if (set.has(8) && nums[0] === 8 && nums[1] === 8) return '8x8';
  if (set.has(14)) return '10x14';
  if (set.has(20)) return '10x20';
  if (set.has(26)) return '10x26';
  if (set.has(8))  return '8x8';
  return null;
}

(async () => {
  console.log('🔍 Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Capture any JSON the portal loads — useful backup source for prices.
  const apiPayloads = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) apiPayloads.push({ url: res.url(), body: await res.json() });
    } catch (_) {}
  });

  console.log('🌐 Loading StorEdge rental center...');
  await page.goto(RENT_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 5000)); // let Angular finish rendering

  // ── 1) Scrape the rendered unit cards ───────────────────────────────────────
  const scraped = await page.evaluate(() => {
    const selectors = [
      '.unit-type-card', '.unit-card', '[class*="unit-type"]',
      '.available-unit', '.panel', '[class*="UnitType"]',
    ];
    let cards = [];
    for (const sel of selectors) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length) break;
    }
    if (!cards.length) {
      return { fallbackText: document.body.innerText.slice(0, 4000), cards: [] };
    }
    return {
      fallbackText: null,
      cards: cards.map((card) => {
        const text = card.innerText || '';
        return {
          rawText: text.trim().slice(0, 200),
          size: (text.match(/(\d+\s*[x×]\s*\d+)/i) || [])[1] || null,
          price: (text.match(/\$(\d+(?:\.\d{2})?)/) || [])[0] || null,
          available:
            !/not available|unavailable|waitlist|sold out|coming soon/i.test(text) &&
            !!card.querySelector('button:not([disabled]), a'),
        };
      }),
    };
  });

  await browser.close();

  // ── 2) Build the units object ───────────────────────────────────────────────
  let existing = { units: {} };
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch {}
  const units = { ...existing.units };

  let found = 0;
  console.log(`\n📦 Found ${scraped.cards.length} unit card(s)\n`);
  for (const card of scraped.cards) {
    const key = normaliseKey(card.size) || normaliseKey(card.rawText);
    if (!key) continue;
    // Keep the LOWEST price we see for a given size (= "starting at")
    const prev = units[key]?.perMonth;
    const num  = card.price ? parseInt(card.price.replace(/\D/g, ''), 10) : null;
    const useNum = num != null && (prev == null || num < prev || !units[key]?.price)
      ? num : prev;
    units[key] = {
      ...units[key],
      price:     useNum != null ? `$${useNum}` : (units[key]?.price || null),
      perMonth:  useNum != null ? useNum : (units[key]?.perMonth ?? null),
      available: card.available,
      lastSeen:  new Date().toISOString(),
    };
    found++;
    console.log(`  ${key.padEnd(6)} ${(units[key].price || '?').padEnd(6)} ${card.available ? '🟢 available' : '🔴 full'}`);
  }

  if (!found && scraped.fallbackText) {
    console.log('⚠️  No unit cards matched. Raw portal text (for debugging):\n');
    console.log(scraped.fallbackText.slice(0, 1200));
    // Save raw API JSON so you can inspect the real shape if selectors changed
    fs.writeFileSync(path.join(__dirname, 'data', 'storedge-raw.json'),
      JSON.stringify(apiPayloads, null, 2));
    console.log('\n   Raw API JSON dumped to data/storedge-raw.json');
  }

  // ── 3) Write output ─────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    facilityId:  FACILITY_ID,
    units,
  }, null, 2));

  console.log(`\n✅ Saved data/availability.json  (${new Date().toLocaleString()})`);
  if (!found) process.exitCode = 2; // signal "nothing scraped" to cron/logs
})().catch((err) => {
  console.error('❌ Scraper error:', err.message);
  process.exit(1);
});
