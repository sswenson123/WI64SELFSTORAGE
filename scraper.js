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
 *   npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 *
 * Runs gently: opens a real (visible) Chrome window with stealth enabled, and
 * scrape no more than once or twice a day to avoid StorEdge's rate limiting.
 *
 * Keep it current automatically (runs on YOUR Mac — StorEdge blocks
 * cloud/datacenter IPs, so this must run from a real machine):
 *   crontab -e   then add a line (this one runs twice a day, 7am & 7pm):
 *   0 7,19 * * * cd "/Users/sswenson/Claude/Self Storage" && HEADLESS=1 /usr/local/bin/node scraper.js >> scraper.log 2>&1 && git add data/availability.json && git commit -m "Auto: update prices" && git push
 *
 *   (run `which node` to confirm your node path for the cron line)
 */

// Use puppeteer-extra + stealth so the rental center sees a normal browser,
// not an automation tool. Falls back to plain puppeteer if the extras aren't
// installed (run: npm install puppeteer-extra puppeteer-extra-plugin-stealth).
let puppeteer;
try {
  puppeteer = require('puppeteer-extra');
  puppeteer.use(require('puppeteer-extra-plugin-stealth')());
  console.log('🥷 Stealth mode on.');
} catch (_) {
  puppeteer = require('puppeteer');
  console.log('ℹ️  Stealth plugin not installed — using plain puppeteer.');
}
const fs        = require('fs');
const path      = require('path');

// Be a polite scraper: random pause helper.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * 1500);

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
  // headless:false opens a REAL Chrome window — much less likely to be flagged.
  // (Set HEADLESS=1 in the env if you ever want it to run hidden.)
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === '1' ? 'new' : false,
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });
  await wait(jitter(1200)); // small human-like pause before navigating

  // Capture any JSON the portal loads — useful backup source for prices.
  const apiPayloads = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) apiPayloads.push({ url: res.url(), body: await res.json() });
    } catch (_) {}
  });

  console.log('🌐 Loading StorEdge rental center...');
  // StorEdge intermittently returns a 503 "Service Unavailable" page (esp. if
  // hit several times quickly). Retry a few times with a wait before giving up.
  let ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    await page.goto(RENT_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 5000)); // let Angular render
    const body = await page.evaluate(() => document.body.innerText || '');
    if (/service unavailable|temporarily unavailable/i.test(body)) {
      console.log(`⚠️  StorEdge said "Service Unavailable" (try ${attempt}/4). Waiting 30s...`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, 30000));
    } else {
      ok = true;
    }
  }
  if (!ok) {
    await browser.close();
    console.log('\n❌ StorEdge is temporarily down (503). This is on their end, not the site.');
    console.log('   Your existing prices were left untouched. Just run this again later.');
    process.exit(3);
  }

  // ── 1) Grab the rendered card text (fallback / debug only) ───────────────────
  const cardTexts = await page.evaluate(() => {
    const selectors = [
      '.unit-type-card', '.unit-card', '[class*="unit-type"]',
      '.available-unit', '.panel', '[class*="UnitType"]',
    ];
    let cards = [];
    for (const sel of selectors) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length) break;
    }
    return cards.map((c) => (c.innerText || '').trim().slice(0, 200));
  });

  await browser.close();

  // Always save the raw material so the parser can be tuned without re-running.
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'storedge-raw.json'),
    JSON.stringify({ cardTexts, apiPayloads }, null, 2));

  // ── 2) PRIMARY: pull size + price + availability from StorEdge's JSON API ────
  // The portal's data is structured JSON — far more reliable than card text,
  // which runs dimensions into square-footage (e.g. "10 x 20" + "200 sq ft").
  function deepFindUnits(payloads) {
    const out = [];
    const seen = new Set();
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node && typeof node === 'object') {
        // StorEdge unit-groups shape: { size:"10x11x8", price:75, available_units_count:0, area:110 }
        if (typeof node.size === 'string' && node.price != null &&
            (typeof node.price === 'number' || /\d/.test(String(node.price)))) {
          const priceNum = parseFloat(String(node.price).replace(/[^0-9.]/g, ''));
          let available = true;
          if (typeof node.available_units_count === 'number') available = node.available_units_count > 0;
          else if (typeof node.available === 'boolean') available = node.available;
          const sig = node.size + '|' + priceNum + '|' + available;
          if (!seen.has(sig)) { seen.add(sig); out.push({ sizeStr: node.size, price: priceNum, available }); }
        }
        Object.keys(node).forEach((k) => visit(node[k]));
      }
    }
    payloads.forEach((p) => visit(p.body));
    return out;
  }

  // ── 3) Build the units object ───────────────────────────────────────────────
  let existing = { units: {} };
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch {}
  const units = { ...existing.units };

  const apiUnits = deepFindUnits(apiPayloads);
  let found = 0;
  console.log(`\n📦 ${cardTexts.length} card(s) rendered · ${apiUnits.length} priced record(s) in API\n`);

  for (const u of apiUnits) {
    const key = normaliseKey(u.sizeStr);
    if (!key) continue;
    const prev = units[key]?.perMonth;
    const num = !isNaN(u.price) ? Math.round(u.price) : null;
    const useNum = num != null && (prev == null || num < prev) ? num : (prev ?? num);
    units[key] = {
      ...units[key],
      price:     useNum != null ? `$${useNum}` : (units[key]?.price || null),
      perMonth:  useNum != null ? useNum : (units[key]?.perMonth ?? null),
      available: u.available,
      lastSeen:  new Date().toISOString(),
    };
    found++;
  }

  for (const key of ['8x8', '10x14', '10x20', '10x26']) {
    const u = units[key];
    if (!u) continue;
    console.log(`  ${key.padEnd(6)} ${(u.price || '—').padEnd(6)} ${u.available ? '🟢 available' : '🔴 full'}`);
  }

  if (!found) {
    // Don't overwrite good prices with nothing — preserve the last good file.
    console.log('\n⚠️  Nothing matched from the API. Card text captured was:\n');
    cardTexts.forEach((t, i) => console.log(`   [${i}] ${t.replace(/\n/g, ' | ')}`));
    console.log('\n   Existing data/availability.json left untouched.');
    console.log('   Full raw data saved to data/storedge-raw.json — send me that file.');
    process.exit(2);
  }

  // ── 3) Write output (only when we actually got prices) ───────────────────────
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    facilityId:  FACILITY_ID,
    units,
  }, null, 2));

  console.log(`\n✅ Saved data/availability.json  (${new Date().toLocaleString()})`);
})().catch((err) => {
  console.error('❌ Scraper error:', err.message);
  process.exit(1);
});
