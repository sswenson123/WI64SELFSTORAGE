/**
 * End-to-end against the REAL preview Worker (wrangler dev --local), not the
 * stub harness: real D1, real R2, real routing, real static-asset serving.
 * Starts the Worker, drives both flows in a browser, checks what landed in the
 * database, then shuts everything down.
 */
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const API = path.join(import.meta.dirname, '..');

const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const results = [];
let failures = 0;
async function step(name, fn) {
  try { await fn(); results.push('  ✓ ' + name); }
  catch (e) { failures++; results.push('  ✗ ' + name + '\n      ' + String(e.message || e).split('\n')[0]); }
}

function d1(sql) {
  const out = execSync(
    `npx wrangler d1 execute wi64_moveout_preview --config wrangler.preview.toml --local --json --command ${JSON.stringify(sql)}`,
    { cwd: API, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

const worker = spawn('npx', ['wrangler', 'dev', '--config', 'wrangler.preview.toml', '--local',
  '--port', String(PORT), '--ip', '127.0.0.1'],
  { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
worker.stdout.on('data', () => {});
worker.stderr.on('data', () => {});
const shutdown = () => { try { worker.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', shutdown);

let ready = false;
for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2000) });
    if (res.ok) { ready = true; break; }
  } catch { /* not up yet */ }
}
if (!ready) { console.log('Worker never became ready'); shutdown(); process.exit(1); }

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--disable-background-networking', '--no-proxy-server', '--no-first-run', '--disable-sync'],
});

async function newPage(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/move-out.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#moCard:not([hidden])', { timeout: 8000 });
  return { page, ctx, errors };
}

async function addPhoto(page, i) {
  await page.locator(`[data-shot="${i}"]`).click();
  await page.setInputFiles('input[type=file]', { name: 'IMG_0042.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_B64, 'base64') });
  await page.waitForFunction((k) => document.querySelectorAll('.mo-slot')[k]?.classList.contains('done'), i, { timeout: 15000 });
}

await step('the Worker serves the Pleasant Lake site and its assets', async () => {
  for (const p of ['/move-out.html', '/css/styles.css', '/js/move-out.js', '/images/logo-mark.svg']) {
    const res = await fetch(BASE + p);
    assert.equal(res.ok, true, `${p} -> ${res.status}`);
  }
  const html = await (await fetch(BASE + '/move-out.html')).text();
  assert.match(html, /Pleasant Lake Storage/);
  assert.match(html, /PREVIEW — TEST ONLY/);
});

await step('admin fails closed without Cloudflare Access', async () => {
  const res = await fetch(BASE + '/admin');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Cloudflare Access is not configured/);
});

let scheduledId = null;
await step('SCHEDULE flow completes on an iPhone viewport against the real Worker', async () => {
  const { page, ctx, errors } = await newPage({ width: 390, height: 800 }, true);
  await page.locator('[data-go="n1"]').click();
  await page.locator('#f-name').fill('Preview Tester');
  await page.locator('#f-phone').fill('2185550123');
  await page.locator('[data-next="n2"]').click();
  await page.locator('[data-eom]').click();
  await page.locator('[data-next="n3"]').click();
  assert.match(await page.locator('.mo-review').innerText(), /Preview Tester/);
  await page.locator('[data-submit="scheduled"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 15000 });
  assert.match(await page.locator('.mo-done-h').innerText(), /notice received/i);
  assert.equal(errors.length, 0, 'js errors: ' + errors.join('; '));
  const rows = d1("SELECT id, type, customer_name, phone, environment, planned_move_out_date FROM move_out_requests WHERE customer_name = 'Preview Tester'");
  assert.equal(rows.length, 1, 'exactly one row in D1');
  assert.equal(rows[0].type, 'SCHEDULED_MOVE_OUT');
  assert.equal(rows[0].environment, 'PREVIEW', 'stamped PREVIEW, not PRODUCTION');
  assert.equal(rows[0].phone, '2185550123');
  scheduledId = rows[0].id;
  await ctx.close();
});

let completedId = null;
await step('COMPLETED flow completes on an iPhone viewport, photos land in R2', async () => {
  const { page, ctx, errors } = await newPage({ width: 390, height: 800 }, true);
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('a14');
  await page.locator('#f-phone2').fill('2185550123');
  await page.locator('[data-next="o2"]').click();
  await addPhoto(page, 0); await addPhoto(page, 1); await addPhoto(page, 2);
  assert.match(await page.locator('.mo-prog .t').innerText(), /3 of 3 required/);
  await page.locator('[data-next="o3"]').click();
  for (const i of [0, 1, 2]) await page.locator(`[data-conf="${i}"]`).click();
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 15000 });
  assert.match(await page.locator('.mo-stamp').innerText(), /Unit A14/);
  assert.equal(errors.length, 0, 'js errors: ' + errors.join('; '));

  const rows = d1("SELECT id, type, unit_number, environment, completed_at FROM move_out_requests WHERE unit_number = 'A14'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].environment, 'PREVIEW');
  assert.ok(new Date(rows[0].completed_at).getFullYear() >= 2026, 'server timestamp is real');
  completedId = rows[0].id;

  const photos = d1(`SELECT slot, r2_key, bytes FROM move_out_photos WHERE request_id = '${completedId}'`);
  assert.equal(photos.length, 3, 'three photo rows attached');
  assert.deepEqual(photos.map((p) => p.slot).sort(), ['DOOR', 'FLOOR', 'INSIDE']);
  for (const p of photos) assert.ok(p.bytes > 0, 'photo has bytes in R2');
  await ctx.close();
});

await step('Back navigation keeps uploaded photos (no re-upload)', async () => {
  const { page, ctx } = await newPage({ width: 390, height: 800 }, true);
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('B22');
  await page.locator('#f-phone2').fill('2185550199');
  await page.locator('[data-next="o2"]').click();
  await addPhoto(page, 0); await addPhoto(page, 1); await addPhoto(page, 2);
  const before = d1("SELECT COUNT(*) AS n FROM move_out_photos")[0].n;
  await page.locator('[data-next="o3"]').click();
  await page.locator('#moBack').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.mo-slot.done').count(), 3);
  const after = d1("SELECT COUNT(*) AS n FROM move_out_photos")[0].n;
  assert.equal(after, before, 'going back did not re-upload');
  await ctx.close();
});

await step('validation blocks an incomplete submission at the real API', async () => {
  const res = await fetch(BASE + '/api/move-outs/completed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitNumber: '', phone: '123', confirmations: {}, photoIds: [], idempotencyKey: 'x'.repeat(24), uploadToken: 'y'.repeat(24) }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  for (const e of body.errors) assert.match(e.message, /^Please /);
});

await step('desktop rendering works too', async () => {
  const { page, ctx, errors } = await newPage({ width: 1280, height: 900 }, false);
  assert.match(await page.locator('.mo-h').innerText(), /Moving Out\?/);
  await page.locator('[data-go="n1"]').click();
  assert.match(await page.locator('.mo-h').innerText(), /Schedule Your Move-Out/);
  assert.equal(errors.length, 0);
  await ctx.close();
});

await step('every preview record is marked, none look like production', async () => {
  const rows = d1('SELECT environment, COUNT(*) AS n FROM move_out_requests GROUP BY environment');
  assert.equal(rows.length, 1, 'one environment only: ' + JSON.stringify(rows));
  assert.equal(rows[0].environment, 'PREVIEW');
  const outbox = d1('SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status');
  assert.ok(outbox.every((r) => r.status === 'PENDING'), 'nothing was sent: ' + JSON.stringify(outbox));
});

await browser.close();
shutdown();

console.log('\nReal preview Worker (wrangler dev --local, real D1 + R2)');
console.log(results.join('\n'));
console.log(`\n  ${results.length - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
