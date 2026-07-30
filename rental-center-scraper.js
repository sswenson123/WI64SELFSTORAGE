/**
 * storEDGE Rental Center scraper
 * Scrapes unit types, sizes, prices, and availability from rental-center.storedge.com
 *
 * Usage:  node rental-center-scraper.js
 * Output: rental-center-data.json + console summary
 *
 * Requires: npm i puppeteer  (or puppeteer-core + a Chrome binary)
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const COMPANY_ID = 'ef2375f3-b212-4670-bbc0-be544f6614b6';
const FACILITIES = {
  'WI64 / new facility': '159d76bf-6636-4e86-87fe-82fc497dc971',
  'Long Lake Toy Sheds (site link)': 'd8dff67b-e4cd-487b-9d5e-c25cfc771aa5',
};

// Point this at your local Chrome if needed (Mac default shown):
const EXECUTABLE =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function scrapeFacility(browser, label, facilityId) {
  const page = await browser.newPage();
  const apiPayloads = [];

  // Capture every JSON API response the rental center loads
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) {
        const body = await res.json();
        apiPayloads.push({ url: res.url(), body });
      }
    } catch (_) {}
  });

  const url = `https://rental-center.storedge.com/?companyId=${COMPANY_ID}&facilityId=${facilityId}#/move-in`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000)); // let Angular finish rendering

  const pageText = await page.evaluate(() => document.body.innerText);
  await page.close();
  return { label, facilityId, url, pageText, apiPayloads };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXECUTABLE,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results = [];
  for (const [label, id] of Object.entries(FACILITIES)) {
    console.log(`Scraping ${label}...`);
    try {
      results.push(await scrapeFacility(browser, label, id));
    } catch (e) {
      results.push({ label, facilityId: id, error: e.message });
    }
  }
  await browser.close();

  fs.writeFileSync('rental-center-data.json', JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`\n===== ${r.label} =====`);
    console.log(r.error ? `ERROR: ${r.error}` : r.pageText?.slice(0, 3000));
  }
  console.log('\nFull data (incl. raw API JSON) saved to rental-center-data.json');
})();
