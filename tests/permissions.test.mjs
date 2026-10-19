/*
 * The opt-in websites (the price guide, PokemonPriceTracker) are optional host
 * permissions: a new install may only reach Cardmarket. Loads the real
 * manifest, without anything granted. (Chrome's own question cannot be
 * answered from a test; e2e.test.mjs runs with both allowed.)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BROWSER, OFFLINE_ARGS, extensionWorker, extensionCopy } from './browser.mjs';
import { createMockCardmarket } from './mock-cardmarket.mjs';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSA = 'https://www.pokemonpricetracker.com/*';
const TREND = 'https://downloads.s3.cardmarket.com/*';

let context;
let sw;
let extensionId;
const hits = { psa: 0, trend: 0 };

async function waitFor(check, message, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

before(async () => {
  const extension = extensionCopy(ROOT);
  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'cmcs-profile-')), {
    ...BROWSER,
    headless: true,
    locale: 'nl-NL',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--lang=nl', ...OFFLINE_ARGS],
  });
  await context.route('https://www.cardmarket.com/**', createMockCardmarket().route);
  await context.route('https://www.pokemonpricetracker.com/**', (r) => ((hits.psa += 1), r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' })));
  await context.route('https://downloads.s3.cardmarket.com/**', (r) => ((hits.trend += 1), r.fulfill({ status: 200, contentType: 'application/json', body: '{"priceGuides":[]}' })));
  sw = await extensionWorker(context);
  extensionId = new URL(sw.url()).host;
});

after(async () => {
  await context?.close();
});

describe('opt-in websites', () => {
  it('a new install may only reach Cardmarket', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.host_permissions, ['https://www.cardmarket.com/*', 'https://product-images.s3.cardmarket.com/*']);
    assert.deepEqual(manifest.optional_host_permissions.sort(), [TREND, PSA].sort());
    const granted = await sw.evaluate(
      ([psa, trend]) =>
        Promise.all([
          chrome.permissions.contains({ origins: ['https://www.cardmarket.com/*'] }),
          chrome.permissions.contains({ origins: [psa] }),
          chrome.permissions.contains({ origins: [trend] }),
        ]),
      [PSA, TREND],
    );
    assert.deepEqual(granted, [true, false, false]);
  });

  it('switched on elsewhere (sync) but not allowed here: nothing is sent, and the settings page asks', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.settings': { psaEstimate: true, pptApiKey: 'k', priceTrend: true } }));
    const psa = await sw.evaluate(() => self.cmcs.psa.refresh({ force: true }));
    const prices = await sw.evaluate(() => self.cmcs.refreshPrices({ force: true }));
    assert.equal(psa.error, 'permission');
    assert.equal(prices.error, 'permission');
    assert.deepEqual(hits, { psa: 0, trend: 0 }, 'not one request');

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await waitFor(async () => /pokemonpricetracker\.com in deze browser nog niet/.test(await options.locator('#psaStatus').innerText()), 'PSA asks');
    await waitFor(async () => /downloads\.s3\.cardmarket\.com in deze browser nog niet/.test(await options.locator('#trendStatus').innerText()), 'trend asks');
    assert.ok(await options.locator('#psaGrant').isVisible());
    assert.ok(await options.locator('#trendGrant').isVisible());
    assert.equal(await options.locator('#psaGrant').innerText(), 'Toestemming geven');

    // Switching off needs no question.
    await options.locator('#psaEstimate').uncheck();
    await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('cmcs.settings')))['cmcs.settings'].psaEstimate === false, 'off');
    await waitFor(async () => !(await options.locator('#psaGrant').isVisible()), 'no question when off');
    await options.close();
  });
});
