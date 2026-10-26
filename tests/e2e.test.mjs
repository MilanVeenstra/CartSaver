/*
 * End-to-end test: loads the unpacked extension in Chromium and points
 * https://www.cardmarket.com at the mock in ./mock-cardmarket.mjs, so the real
 * content scripts, popup and service worker run against Cardmarket-shaped
 * pages and endpoints.
 *
 *   npm test                         # run
 *   SCREENSHOT_DIR=shots npm test    # also save screenshots
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BROWSER, OFFLINE_ARGS, extensionWorker, extensionCopy } from './browser.mjs';
import { createMockCardmarket, ARTICLES } from './mock-cardmarket.mjs';

// Let context.route() also see the extension service worker's requests (the price guide).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SCREENSHOT_DIR ? path.resolve(process.env.SCREENSHOT_DIR) : null;
const CM = 'https://www.cardmarket.com';
const [BOG, MAGE, EPHEMERATE, SOL_RING, SOL_KINGDOM, SOL_MINT] = ARTICLES.map((a) => a.articleId);
const SOL_RING_URL = `https://www.cardmarket.com/en/Magic/Products/Singles/Commander-Masters/Sol-Ring`;
const DELAY_MS = 300;

let context;
let sw;
let extensionId;
let mock;

async function storage() {
  return sw.evaluate(() => chrome.storage.local.get(null));
}

async function items() {
  return (await storage())['cmcs.items'] || {};
}

async function patchItems(patch) {
  await sw.evaluate(async (p) => {
    const { 'cmcs.items': current = {} } = await chrome.storage.local.get('cmcs.items');
    for (const [id, fields] of Object.entries(p)) current[id] = { ...current[id], ...fields };
    await chrome.storage.local.set({ 'cmcs.items': current });
  }, patch);
}

async function waitFor(check, message, timeout = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

async function shot(target, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const widget = (page) => page.locator('cmcs-cart-saver .cmcs-panel');
async function favorites() {
  return (await storage())['cmcs.favorites'] || {};
}

/**
 * Click something in the popup that queues a job and opens Cardmarket in a new
 * tab, then let that tab run the job. (Playwright cannot intercept the first
 * load of a tab the extension opened itself, so it is loaded once more.)
 */
async function runViaNewTab(locator) {
  await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
  const opened = context.waitForEvent('page');
  await locator.click();
  const tab = await opened;
  await tab.waitForLoadState();
  await tab.goto(`${CM}/en/Magic/ShoppingCart`);
  const job = await waitFor(async () => {
    const j = (await storage())['cmcs.job'];
    return j && (j.state === 'done' || j.state === 'error') && j;
  }, 'job finished');
  await tab.close();
  return job;
}

const addRequests = () => mock.state.requests.filter((r) => r.method === 'POST' && r.path.includes('/AjaxAction/ShoppingCart_'));

/**
 * Close the last refill's result when it is still shown. A refill that went
 * fully right is only said once (a strip, or a line in the cart view) and
 * closes by itself; one with failures waits for "Close".
 */
async function closeResult(page) {
  const close = page
    .locator('cmcs-cart-saver')
    .locator('.cmcs-panel[data-view="summary"] .cmcs-head [aria-label="Sluiten"], .cmcs-result [aria-label="Sluiten"]')
    .first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

before(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcs-profile-'));
  // The price guide and PSA tests need their opt-in websites allowed (see permissions.test.mjs for asking).
  const extension = extensionCopy(ROOT, { grantOptional: true });
  context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
    headless: true,
    locale: 'nl-NL',
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--lang=nl', ...OFFLINE_ARGS],
  });
  mock = createMockCardmarket();
  await context.route(`${CM}/**`, mock.route);
  // Card pictures, served like Cardmarket's picture server does: never with CORS
  // headers, and only to cardmarket.com pages and to the extension itself (in
  // reality its declarativeNetRequest rule gives those requests a cardmarket.com
  // Referer; Playwright sees requests before that rule, so it is checked on its
  // own in 'card pictures'). Anything under /broken/ is refused.
  await context.route('https://product-images.s3.cardmarket.com/**', (r) => {
    const request = r.request();
    let from = 'chrome-extension://'; // a service-worker request has no frame: the extension's background
    try {
      from = request.frame().url();
    } catch {
      // Keep the default.
    }
    const allowed = from.startsWith('chrome-extension://') || from.startsWith(`${CM}/`);
    if (!allowed || request.url().includes('/broken/')) {
      return r.fulfill({ status: 403, contentType: 'text/html', body: '<h1>403 ERROR</h1><h2>The request could not be satisfied.</h2>' });
    }
    return r.fulfill({ path: path.join(ROOT, 'tests/fixtures/card.png'), contentType: 'multerS3.AUTO_CONTENT_TYPE' });
  });
  sw = await extensionWorker(context);
  extensionId = new URL(sw.url()).host;
  await sw.evaluate((delayMs) => chrome.storage.local.set({ 'cmcs.settings': { delayMs } }), DELAY_MS);
});

after(async () => {
  await context?.close();
});

describe('Cardmarket Cart Saver', () => {
  let page;

  it('saves every article when the cart page is opened', async () => {
    mock.state.cart = new Map([
      [BOG, 2],
      [MAGE, 1],
      [EPHEMERATE, 1],
    ]);
    page = await context.newPage();
    await page.goto(`${CM}/en/Magic/ShoppingCart`);

    const saved = await waitFor(async () => {
      const all = await items();
      return Object.keys(all).length === 3 && Object.values(all).every((i) => i.status === 'in_cart') && all;
    }, 'three saved articles');

    assert.equal(saved[BOG].name, 'Bojuka Bog');
    assert.equal(saved[BOG].amount, 2);
    assert.equal(saved[BOG].price, 0.99);
    assert.equal(saved[BOG].game, 'Magic');
    assert.equal(saved[BOG].lang, 'en');
    assert.equal(saved[BOG].productUrl, `${CM}/en/Magic/Products/Singles/Commander-2018/Bojuka-Bog`);
    assert.equal(saved[BOG].seller, 'snowc');
    assert.equal(saved[BOG].foil, false);
    assert.match(saved[BOG].imageUrl, /product-images\.s3\.cardmarket\.com\/.*361919\.jpg$/);
    assert.equal(saved[MAGE].foil, true);
    assert.equal(saved[MAGE].conditionLabel, 'EX');
    assert.equal(saved[MAGE].condition, 3);
    assert.equal(saved[MAGE].languageLabel, 'German');
    assert.deepEqual(saved[MAGE].extras, ['Foil']);
    assert.equal(saved[EPHEMERATE].seller, 'Kärtchen-Laden');
    assert.equal(saved[EPHEMERATE].expansion, 'Modern Horizons');

    await waitFor(() => widget(page).isVisible(), 'cart panel');
    // Counted in copies (the Bog twice), like the amounts.
    assert.match(await widget(page).innerText(), /4 artikelen in je mandje zijn opgeslagen/);
    await shot(page, '01-cart-saved');
  });

  it('notices an emptied cart on another page and offers to put it back', async () => {
    mock.state.cart.clear(); // Cardmarket emptied the cart…
    mock.state.available.delete(EPHEMERATE); // …and one article was sold meanwhile.

    await page.goto(`${CM}/en/Magic`);
    await waitFor(async () => Object.values(await items()).every((i) => i.status === 'missing'), 'all missing');
    assert.ok(Object.values(await items()).every((i) => i.missingReason === 'emptied'), 'the whole cart went');

    await waitFor(() => widget(page).isVisible(), 'reminder');
    const text = await widget(page).innerText();
    assert.match(text, /Je winkelmandje is geleegd/);
    assert.match(text, /4 opgeslagen artikelen \(5,78 €\)/);
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '4');
    await shot(widget(page), '02-reminder');
  });

  it('puts the articles back with one click: one request per seller, spaced out', async () => {
    const before = addRequests().length;
    await widget(page).getByRole('button', { name: /^Zet 4 terug in je mandje/ }).click();

    const job = await waitFor(async () => {
      const j = (await storage())['cmcs.job'];
      return j && j.state === 'done' && j;
    }, 'refill job done');

    assert.equal(job.added, 2);
    assert.equal(job.failed, 1);
    assert.deepEqual([...mock.state.cart.entries()].sort(), [[BOG, 2], [MAGE, 1]].sort());

    const saved = await items();
    assert.equal(saved[BOG].status, 'in_cart');
    assert.equal(saved[MAGE].status, 'in_cart');
    assert.equal(saved[EPHEMERATE].status, 'unavailable');
    assert.equal(saved[EPHEMERATE].lastAttempt.message, 'This article is no longer available.');

    // snowc's two articles go in one request; Kärtchen-Laden's on its own.
    const posts = addRequests().slice(before);
    assert.equal(posts.length, 2);
    const sent = [];
    for (const post of posts) {
      assert.match(post.path, /^\/en\/Magic\/AjaxAction\/ShoppingCart_Add_AddArticlesFromUserOffers$/);
      const body = new URLSearchParams(post.body);
      assert.equal(body.get('__cmtkn'), mock.state.token);
      const ids = JSON.parse(body.get('idArticle'));
      const amounts = JSON.parse(body.get('amount'));
      for (const id of Object.keys(ids)) {
        assert.equal(ids[id], id);
        assert.equal(amounts[id], String(id === BOG ? 2 : 1));
      }
      sent.push(Object.keys(ids).sort());
    }
    assert.deepEqual(sent, [[BOG, MAGE].sort(), [EPHEMERATE]]);
    for (let i = 1; i < posts.length; i += 1) {
      assert.ok(posts[i].at - posts[i - 1].at >= DELAY_MS, 'requests are spaced out');
    }

    await waitFor(async () => /2 artikelen terug in je mandje\. 1 lukte niet\./.test(await widget(page).innerText()), 'summary');
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
    await shot(widget(page), '03-refill-summary');
  });

  it('lists unavailable articles on the cart page with a link to similar offers', async () => {
    await closeResult(page);
    await page.goto(`${CM}/en/Magic/ShoppingCart`);
    await waitFor(() => widget(page).isVisible(), 'cart panel');
    const text = await widget(page).innerText();
    assert.match(text, /3 artikelen in je mandje zijn opgeslagen/);
    assert.match(text, /Niet meer beschikbaar \(1\)/i);
    // One way to look for something else: "Find a replacement", with all similar offers under it.
    const sold = widget(page).locator(`.cmcs-item--unavailable[data-article-id="${EPHEMERATE}"]`);
    assert.equal(await sold.getByRole('link', { name: 'Zoek vergelijkbaar aanbod' }).count(), 0, 'no second button for the same');
    await sold.getByRole('button', { name: 'Vervanging zoeken' }).click();
    const alt = widget(page).getByRole('link', { name: 'Alle aanbiedingen op Cardmarket' });
    await waitFor(() => alt.isVisible(), 'link to all offers');
    assert.equal(
      await alt.getAttribute('href'),
      `${CM}/en/Magic/Products/Singles/Modern-Horizons/Ephemerate?language=1&minCondition=2`,
    );
    await shot(page, '04-cart-panel');
    await sold.getByRole('button', { name: 'Verberg vervanging' }).click();
  });

  it('shows everything in the popup', async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.locator('#tab-cart').click();
    await waitFor(async () => /Alles wat nog te koop is, zit in je mandje/.test(await popup.locator('#summary').innerText()), 'summary');
    assert.match(await popup.locator('#summary').innerText(), /3 artikelen · 2,23 € bij 1 verkoper/);
    // What is gone carries the stamp; what is in the cart is listed below it, always unfolded.
    assert.match(await popup.locator('#list').innerText(), /Ephemerate[\s\S]*VERKOCHT[\s\S]*3 in je mandje/);
    assert.equal(await popup.locator('#list .cmcs-item').count(), 3);
    assert.equal(await popup.getByRole('button', { name: 'Toon' }).count(), 0);
    await shot(popup, '05-popup');
    await popup.close();
  });

  it("saves articles added with the site's own button", async () => {
    await page.goto(`${CM}/en/Magic/Products/Singles/Commander-Masters/Sol-Ring`);
    await page.click('#site-add');
    await waitFor(async () => (await items())[SOL_RING]?.status === 'in_cart', 'Sol Ring saved');
  });

  it('forgets articles once they show up on an order page', async () => {
    // Bought, so gone from the cart. The Mage was bought once too, but is in the cart again now.
    mock.state.cart.delete(BOG);
    mock.state.cart.set(MAGE, 1);
    await page.goto(`${CM}/en/Magic/Orders/1234567?ids=${BOG},${MAGE}`);
    await waitFor(async () => !(await items())[BOG], 'bought article removed');
    await waitFor(async () => (await items())[MAGE]?.status === 'in_cart', 'the one in the cart again stays saved');
  });

  it('refills from the popup by opening Cardmarket when no Cardmarket tab is active', async () => {
    mock.state.cart.clear();
    await patchItems({ [MAGE]: { status: 'missing' }, [SOL_RING]: { status: 'missing' } });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const opened = context.waitForEvent('page');
    await popup.getByRole('button', { name: /^Zet 2 terug in je mandje/ }).click();
    const cartTab = await opened;
    assert.match(await popup.locator('#notice').innerText(), /het terugzetten start vanzelf/);
    // Playwright cannot intercept the very first load of a tab the extension
    // opened itself, so load it again through the mock. The queued job is
    // still waiting and gets picked up by the content script.
    await cartTab.waitForLoadState();
    await cartTab.goto(`${CM}/en/Magic/ShoppingCart`);

    await waitFor(async () => (await storage())['cmcs.job']?.state === 'done', 'queued job done');
    assert.deepEqual([...mock.state.cart.keys()].sort(), [MAGE, SOL_RING].sort());
    const saved = await items();
    assert.equal(saved[MAGE].status, 'in_cart');
    assert.equal(saved[SOL_RING].status, 'in_cart');
    await popup.close();
    await cartTab.close();
  });

  it('falls back to the other add-to-cart endpoint and remembers it', async (t) => {
    t.after(() => (mock.state.addEndpoint = 'ShoppingCart_Add_AddArticlesFromUserOffers'));
    mock.state.addEndpoint = 'ShoppingCart_Add_AddArticlesFromProductPage';
    mock.state.cart.delete(MAGE);
    await patchItems({ [MAGE]: { status: 'missing' } });
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));

    const before = addRequests().length;
    await page.goto(`${CM}/en/Magic`);
    await widget(page).getByRole('button', { name: /^Zet 1 terug in je mandje/ }).click();
    await waitFor(async () => (await storage())['cmcs.job']?.state === 'done', 'job done');

    assert.ok(mock.state.cart.has(MAGE));
    const paths = addRequests().slice(before).map((r) => r.path.split('/').pop());
    assert.deepEqual(paths, ['ShoppingCart_Add_AddArticlesFromUserOffers', 'ShoppingCart_Add_AddArticlesFromProductPage']);
    assert.equal((await storage())['cmcs.meta'].addEndpoint, 'ShoppingCart_Add_AddArticlesFromProductPage');
  });

  it('stops at a Cloudflare check without marking articles unavailable', async () => {
    mock.state.challenge = true;
    mock.state.cart.delete(MAGE);
    await patchItems({ [MAGE]: { status: 'missing' } });
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));

    await page.goto(`${CM}/en/Magic`);
    await widget(page).getByRole('button', { name: /^Zet 1 terug in je mandje/ }).click();
    const job = await waitFor(async () => {
      const j = (await storage())['cmcs.job'];
      return j && j.state === 'error' && j;
    }, 'job stopped');
    assert.equal(job.error, 'challenge');
    assert.equal((await items())[MAGE].status, 'missing');
    assert.match(await widget(page).innerText(), /beveiligingscontrole/);
    mock.state.challenge = false;
  });

  it('never treats an unreadable cart page as empty', async (t) => {
    t.after(() => (mock.state.brokenRows = false));
    mock.state.cart = new Map([
      [MAGE, 1],
      [SOL_RING, 1],
    ]);
    await patchItems({ [MAGE]: { status: 'in_cart' }, [SOL_RING]: { status: 'in_cart' } });
    mock.state.brokenRows = true;
    await page.goto(`${CM}/en/Magic/ShoppingCart`);
    await new Promise((r) => setTimeout(r, 1500));
    const saved = await items();
    assert.equal(saved[MAGE].status, 'in_cart');
    assert.equal(saved[SOL_RING].status, 'in_cart');

    // A refill must refuse to run on a cart it cannot read.
    await patchItems({ [MAGE]: { status: 'missing' } });
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
    const before = addRequests().length;
    await page.goto(`${CM}/en/Magic`);
    await widget(page).getByRole('button', { name: /^Zet 1 terug in je mandje/ }).click();
    const job = await waitFor(async () => {
      const j = (await storage())['cmcs.job'];
      return j && j.state === 'error' && j;
    }, 'job refused');
    assert.equal(job.error, 'cart_unreadable');
    assert.equal(addRequests().length, before);
  });

  it('skips articles that are already back in the cart', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
    mock.state.cart.set(MAGE, 1);
    mock.state.cart.delete(SOL_RING);
    await patchItems({ [MAGE]: { status: 'missing' }, [SOL_RING]: { status: 'missing' } });
    // Pretend the header count was already seen, so the page itself does not
    // re-sync and the saved list is stale (MAGE was re-added in another tab).
    await sw.evaluate(async () => {
      const { 'cmcs.meta': meta = {} } = await chrome.storage.local.get('cmcs.meta');
      meta.cartSync = { at: Date.now(), headerCount: 1 };
      meta.addEndpoint = 'ShoppingCart_Add_AddArticlesFromUserOffers';
      await chrome.storage.local.set({ 'cmcs.meta': meta });
    });

    const before = addRequests().length;
    await page.goto(`${CM}/en/Magic`);
    await widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }).click();
    await waitFor(async () => (await storage())['cmcs.job']?.state === 'done', 'job done');

    const posts = addRequests().slice(before);
    assert.equal(posts.length, 1);
    assert.ok(JSON.parse(new URLSearchParams(posts[0].body).get('idArticle'))[SOL_RING]);
    assert.equal(mock.state.cart.get(MAGE), 1, 'quantity not raised');
    const saved = await items();
    assert.equal(saved[MAGE].status, 'in_cart');
    assert.equal(saved[SOL_RING].status, 'in_cart');
  });

  it('uses the fresh token from the cart it just read, not an outdated one on the page', async (t) => {
    t.after(() => (mock.state.stalePageToken = null));
    mock.state.stalePageToken = 'deadbeef'.repeat(8);
    mock.state.cart.delete(MAGE);
    await patchItems({ [MAGE]: { status: 'missing' } });
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));

    const before = addRequests().length;
    await page.goto(`${CM}/en/Magic`);
    await widget(page).getByRole('button', { name: /^Zet 1 terug in je mandje/ }).click();
    await waitFor(async () => (await storage())['cmcs.job']?.state === 'done', 'job done');

    const tokens = addRequests().slice(before).map((r) => new URLSearchParams(r.body).get('__cmtkn'));
    assert.deepEqual(tokens, [mock.state.token], 'one request, with the token of the cart page');
    assert.ok(mock.state.cart.has(MAGE));
    assert.equal((await items())[MAGE].status, 'in_cart');
  });

  it('stars offers on a product page', async () => {
    await page.goto(SOL_RING_URL);
    const star = page.locator(`#articleRow${SOL_KINGDOM} cmcs-fav button`);
    assert.equal(await star.getAttribute('aria-pressed'), 'false');
    assert.equal(await star.getAttribute('title'), 'Bewaar als favoriet');
    await star.click();
    const fav = await waitFor(async () => (await favorites())[SOL_KINGDOM], 'favourite saved');

    assert.equal(fav.name, 'Sol Ring');
    assert.equal(fav.expansion, 'Commander Masters');
    assert.equal(fav.productUrl, SOL_RING_URL);
    assert.equal(fav.game, 'Magic');
    assert.equal(fav.lang, 'en');
    assert.equal(fav.seller, 'CardKingdomNL');
    assert.equal(fav.sellerUrl, `${CM}/en/Magic/Users/CardKingdomNL`);
    assert.equal(fav.price, 1.1);
    assert.equal(fav.available, 3);
    assert.equal(fav.conditionLabel, 'EX');
    assert.equal(fav.condition, 3);
    assert.equal(fav.languageLabel, 'German');
    assert.equal(fav.language, 3);
    assert.equal(fav.foil, false);
    // The page shows the previous and next card of the set too: the picture must be this one.
    assert.match(fav.imageUrl, /\/500100\/500100\.jpg$/);
    assert.equal(fav.productId, '500100');
    await waitFor(async () => (await star.getAttribute('aria-pressed')) === 'true', 'star filled');

    await page.locator(`#articleRow${SOL_MINT} cmcs-fav button`).click();
    const mint = await waitFor(async () => (await favorites())[SOL_MINT], 'second favourite');
    assert.equal(mint.foil, true);
    assert.deepEqual(mint.extras, ['Foil']);
    assert.equal(mint.conditionLabel, 'MT');
    await shot(page, '07-product-stars');

    // Clicking again removes it; clicking once more brings it back.
    await star.click();
    await waitFor(async () => !(await favorites())[SOL_KINGDOM], 'unstarred');
    await star.click();
    await waitFor(async () => (await favorites())[SOL_KINGDOM], 'starred again');
  });

  it('keeps one star per offer while the page keeps changing', async () => {
    await page.goto(SOL_RING_URL);
    await page.locator(`#articleRow${SOL_KINGDOM} cmcs-fav`).waitFor();
    // Cardmarket's own scripts (ratings badge, pictures, ads) change the page after it loaded.
    await page.evaluate(() => document.body.append(document.createElement('span')));
    await page.waitForTimeout(1500);
    const perRow = await page
      .locator('.article-row[id^="articleRow"]')
      .evaluateAll((rows) => rows.map((row) => row.querySelectorAll('cmcs-fav').length));
    assert.ok(perRow.length > 1, 'offers on the page');
    assert.deepEqual(perRow, perRow.map(() => 1));
  });

  it('stars an article from the cart page', async () => {
    mock.state.cart.set(BOG, 1);
    await page.goto(`${CM}/en/Magic/ShoppingCart`);
    await page.locator(`tr[data-article-id="${BOG}"] cmcs-fav button`).first().click();
    const fav = await waitFor(async () => (await favorites())[BOG], 'cart favourite');
    assert.equal(fav.seller, 'snowc');
    assert.equal(fav.conditionLabel, 'NM');
    assert.equal(fav.amount, undefined, 'the cart amount is not part of a favourite');
    await page.locator(`tr[data-article-id="${BOG}"] cmcs-fav button`).first().click();
    await waitFor(async () => !(await favorites())[BOG], 'cart favourite removed');
    mock.state.cart.delete(BOG);
  });

  it('finds favourites back in the popup', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.getByRole('tab', { name: 'Favorieten 2' }).click();
    await waitFor(async () => (await popup.locator('#fav-list .cmcs-item').count()) === 2, 'two favourites');

    // Newest first.
    const names = await popup.locator('#fav-list .cmcs-item').evaluateAll((rows) => rows.map((r) => r.dataset.articleId));
    assert.deepEqual(names, [SOL_KINGDOM, SOL_MINT]);

    const row = popup.locator(`#fav-list [data-article-id="${SOL_KINGDOM}"]`);
    assert.match(await row.innerText(), /CardKingdomNL · 3 beschikbaar · bewaard/);
    // On the row: in the cart and the star; the links wait in the opened row.
    assert.equal(await row.locator('.cmcs-item-actions .cmcs-icon-btn').count(), 2);
    await row.locator('.cmcs-item-line').click();
    assert.equal(
      await row.getByRole('link', { name: 'Op Cardmarket' }).getAttribute('href'),
      `${SOL_RING_URL}?language=3&minCondition=3#articleRow${SOL_KINGDOM}`,
    );
    assert.equal(
      await row.getByRole('link', { name: 'Zoek bij deze verkoper' }).getAttribute('href'),
      `${CM}/en/Magic/Users/CardKingdomNL/Offers/Singles?name=Sol+Ring`,
    );
    assert.doesNotMatch(await popup.locator('body').innerText(), /\bnull\b|undefined/);
    await shot(popup, '08-popup-favorites');

    await popup.fill('#fav-search', 'mint foil');
    await waitFor(async () => (await popup.locator('#fav-list .cmcs-item').count()) === 1, 'search narrows');
    assert.equal(await popup.locator('#fav-list .cmcs-item').getAttribute('data-article-id'), SOL_MINT);
    await popup.fill('#fav-search', 'nothing like this');
    await waitFor(async () => /Geen favorieten gevonden/.test(await popup.locator('#fav-list').innerText()), 'no matches');
    await popup.close();
  });

  it('opening a favourite highlights the offer and refreshes its price', async () => {
    mock.article(SOL_KINGDOM).price = 0.95;
    await page.goto(`${SOL_RING_URL}?language=3&minCondition=3#articleRow${SOL_KINGDOM}`);
    await page.locator(`#articleRow${SOL_KINGDOM}[data-cmcs-highlight]`).waitFor();
    await waitFor(async () => (await favorites())[SOL_KINGDOM].price === 0.95, 'price refreshed');
  });

  it('finds a favourite on the seller page', async () => {
    await page.goto(`${CM}/en/Magic/Users/CardKingdomNL/Offers/Singles?name=Sol+Ring`);
    // A seller's own pages call their rows stockRow<id>, not articleRow<id>.
    const star = page.locator(`#stockRow${SOL_KINGDOM} cmcs-fav button`);
    await waitFor(async () => (await star.getAttribute('aria-pressed')) === 'true', 'shown as favourite');
  });

  it("stars an offer on a seller's page, with the product from the row", async () => {
    await page.goto(`${CM}/en/Magic/Users/Kärtchen-Laden/Offers/Singles`);
    await page.locator(`#stockRow${SOL_RING} cmcs-fav button`).click();
    const fav = await waitFor(async () => (await favorites())[SOL_RING], 'favourite from a seller page');
    assert.equal(fav.seller, 'Kärtchen-Laden');
    assert.equal(fav.productUrl, SOL_RING_URL);
    assert.match(fav.imageUrl, /\/500100\/500100\.jpg$/);
    assert.equal(fav.productId, '500100', 'read from the picture');
    assert.equal(fav.language, 1);
    assert.equal(fav.conditionLabel, 'NM');
    await page.locator(`#stockRow${SOL_RING} cmcs-fav button`).click();
    await waitFor(async () => !(await favorites())[SOL_RING], 'unstarred again');
  });

  it('knows the language on the German site too ("Englisch")', async () => {
    await page.goto(`${CM}/de/Magic/Products/Singles/Commander-Masters/Sol-Ring`);
    const star = page.locator(`#articleRow${SOL_RING} cmcs-fav button`);
    await star.click();
    const fav = await waitFor(async () => (await favorites())[SOL_RING], 'favourite on the German site');
    assert.equal(fav.languageLabel, 'Englisch');
    assert.equal(fav.language, 1, 'the flag says English');
    assert.equal(fav.lang, 'de');
    await star.click();
    await waitFor(async () => !(await favorites())[SOL_RING], 'unstarred again');
  });

  it("searches a seller's sealed products where they are, in the article's own game", async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const urls = await popup.evaluate(() => [
      CMCS.cm.sellerSearchUrl({
        name: '30th Celebration Elite Trainer Box',
        game: 'Pokemon',
        lang: 'en',
        productUrl: 'https://www.cardmarket.com/en/Pokemon/Products/Elite-Trainer-Boxes/30th-Celebration-Elite-Trainer-Box',
        // Saved from the Magic cart page: one cart for all games.
        sellerUrl: 'https://www.cardmarket.com/en/Magic/Users/snowc',
      }),
      CMCS.cm.sellerSearchUrl({ name: 'Sol Ring', game: 'Magic', lang: 'en', productUrl: `${location.origin}/x`, sellerUrl: 'https://www.cardmarket.com/en/Magic/Users/snowc' }),
    ]);
    assert.equal(urls[0], `${CM}/en/Pokemon/Users/snowc/Offers/Elite-Trainer-Boxes?name=30th+Celebration+Elite+Trainer+Box`);
    assert.equal(urls[1], `${CM}/en/Magic/Users/snowc/Offers/Singles?name=Sol+Ring`, 'singles when the kind is unknown');
    await popup.close();
  });

  it('puts a favourite in the cart from the popup (one copy)', async () => {
    mock.state.cart.delete(SOL_KINGDOM);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.getByRole('tab', { name: /Favorieten/ }).click();
    const row = popup.locator(`#fav-list [data-article-id="${SOL_KINGDOM}"]`);
    const job = await runViaNewTab(row.getByRole('button', { name: 'In winkelmandje leggen' }));

    assert.equal(job.state, 'done');
    assert.equal(mock.state.cart.get(SOL_KINGDOM), 1, 'one copy, not all 3 available');
    assert.equal((await items())[SOL_KINGDOM].status, 'in_cart');
    await waitFor(async () => /In je mandje/.test(await row.innerText()), 'popup shows it is in the cart');
    assert.equal(await row.getByRole('button', { name: 'In winkelmandje leggen' }).count(), 0);
    await popup.close();
  });

  it('flags a sold favourite and says so on the offer page', async () => {
    mock.state.available.delete(SOL_MINT);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.getByRole('tab', { name: /Favorieten/ }).click();
    const row = popup.locator(`#fav-list [data-article-id="${SOL_MINT}"]`);
    const job = await runViaNewTab(row.getByRole('button', { name: 'In winkelmandje leggen' }));

    assert.equal(job.failed, 1);
    const fav = (await favorites())[SOL_MINT];
    assert.equal(fav.unavailable, true);
    assert.equal(fav.unavailableMessage, 'This article is no longer available.');
    assert.equal((await items())[SOL_MINT], undefined, 'not added to the saved cart list');
    // In the interface's words; Cardmarket's own (in the site's language) in the tooltip.
    await waitFor(async () => /Niet meer beschikbaar/.test(await row.innerText()), 'note in popup');
    assert.equal(await row.locator('.cmcs-item-note').getAttribute('title'), 'This article is no longer available.');
    await popup.close();

    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
    await page.goto(`${SOL_RING_URL}?language=1&minCondition=1&isFoil=Y#articleRow${SOL_MINT}`);
    await waitFor(() => widget(page).isVisible(), 'notice');
    assert.match(await widget(page).innerText(), /Favoriet niet op deze pagina/);
    assert.equal(
      await widget(page).getByRole('link', { name: 'Zoek bij deze verkoper' }).getAttribute('href'),
      `${CM}/en/Magic/Users/MintCondition/Offers/Singles?name=Sol+Ring`,
    );
    await shot(widget(page), '09-favorite-not-found');
  });

  /** Mark MAGE as missing (and out of the mock cart), then refill it from the reminder. */
  async function refillMageFromReminder(target = page) {
    mock.state.cart.delete(MAGE);
    // Only MAGE is missing; the header count is "already seen" so the page does not re-sync.
    const patch = {};
    for (const [id, item] of Object.entries(await items())) {
      patch[id] = { status: id === MAGE ? 'missing' : item.status === 'missing' ? 'in_cart' : item.status };
    }
    await patchItems(patch);
    const headerCount = [...mock.state.cart.values()].reduce((sum, n) => sum + n, 0);
    await sw.evaluate(
      (count) => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': { cartSync: { at: Date.now(), headerCount: count } } }),
      headerCount,
    );
    await target.goto(`${CM}/en/Magic`);
    await widget(target).getByRole('button', { name: /^Zet 1 terug in je mandje/ }).click();
    return waitFor(async () => {
      const j = (await storage())['cmcs.job'];
      return j && (j.state === 'done' || j.state === 'error') && j;
    }, 'job finished');
  }

  it('talks to its page bridge privately: page scripts see nothing', async () => {
    await page.goto(`${CM}/en/Magic`);
    assert.equal(await page.evaluate(() => 'cmcsBridge' in window || '__cmcsBridge' in window), false, 'no trace on window');
    await page.evaluate(() => {
      window.__seen = [];
      window.addEventListener('message', (e) => e.data && e.data.__cmcs && window.__seen.push(e.data.__cmcs), true);
    });
    const before = mock.state.requests.length;
    const reply = await sw.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { type: 'cmcs.sync' });
    }, `${CM}/en/Magic`);
    assert.equal(reply.ok, true);
    assert.ok(mock.state.requests.slice(before).some((r) => r.path === '/en/Magic/ShoppingCart'), 'the cart was read');
    assert.deepEqual(await page.evaluate(() => window.__seen), []);
  });

  it('reports an unexpected answer as such, not as "not logged in"', async (t) => {
    t.after(() => (mock.state.weirdAdd = false));
    mock.state.weirdAdd = true;
    const job = await refillMageFromReminder();
    assert.equal(job.state, 'error');
    assert.equal(job.error, 'unexpected_response');
    assert.match(job.errorDetail, /HTTP 200 · \/en\/Magic\/AjaxAction\/ShoppingCart_Add_AddArticlesFromUserOffers · text\/html · "Magic \| Cardmarket" · via page/);
    const text = await widget(page).innerText();
    assert.match(text, /onverwacht antwoord/);
    assert.match(text, /Details: HTTP 200/);
    assert.doesNotMatch(text, /niet ingelogd/);
    assert.equal((await items())[MAGE].status, 'missing', 'not marked unavailable');
    await shot(widget(page), '10-unexpected-answer');
  });

  it('says "not logged in" only when Cardmarket shows its login page', async (t) => {
    t.after(() => (mock.state.loggedIn = true));
    mock.state.loggedIn = false;
    const job = await refillMageFromReminder();
    assert.equal(job.error, 'logged_out');
    assert.match(await widget(page).innerText(), /niet ingelogd/);
  });

  it('falls back to its own requests when the page bridge does not answer', async (t) => {
    // A page that grabs the hello before the bridge can (registered even earlier).
    const hostile = await context.newPage();
    t.after(() => hostile.close());
    await hostile.addInitScript(() => {
      window.addEventListener(
        'message',
        (e) => {
          if (e.data && e.data.__cmcs === 'hello') {
            window.__swallowedHello = true;
            e.stopImmediatePropagation();
          }
        },
        true,
      );
    });
    const job = await refillMageFromReminder(hostile);
    assert.equal(await hostile.evaluate(() => window.__swallowedHello), true, 'the bridge really was cut off');
    assert.equal(job.state, 'done');
    assert.ok(mock.state.cart.has(MAGE));
    assert.equal((await items())[MAGE].status, 'in_cart');
  });

  describe('finding the CSRF token on current Cardmarket pages', () => {
    const getsSince = (since, path) => mock.state.requests.slice(since).filter((r) => r.method === 'GET' && r.path === path);

    it('reads it from an inline script when no form field carries it', async (t) => {
      t.after(() => (mock.state.tokenMode = 'input'));
      mock.state.tokenMode = 'script';
      const job = await refillMageFromReminder();
      assert.equal(job.state, 'done', job.errorDetail);
      assert.ok(mock.state.cart.has(MAGE));
    });

    it("picks it up from the site's own (obfuscated) AJAX request", async (t) => {
      t.after(() => (mock.state.tokenMode = 'input'));
      mock.state.tokenMode = 'xhr';
      const since = mock.state.requests.length;
      const job = await refillMageFromReminder();
      assert.equal(job.state, 'done', job.errorDetail);
      assert.ok(mock.state.cart.has(MAGE));
      assert.equal(getsSince(since, '/en/Magic/Wants').length, 0, 'no extra page needed');
      const body = new URLSearchParams(addRequests().at(-1).body);
      assert.equal(body.get('__cmtkn'), mock.state.token);
    });

    it('borrows it from another signed-in page (wants list)', async (t) => {
      t.after(() => (mock.state.tokenMode = 'input'));
      mock.state.tokenMode = 'wants';
      const since = mock.state.requests.length;
      const job = await refillMageFromReminder();
      assert.equal(job.state, 'done', job.errorDetail);
      assert.ok(mock.state.cart.has(MAGE));
      assert.equal(getsSince(since, '/en/Magic/Wants').length, 1);
    });

    it('explains where it looked when there is no token anywhere', async (t) => {
      t.after(() => (mock.state.tokenMode = 'input'));
      mock.state.tokenMode = 'none';
      const before = addRequests().length;
      const job = await refillMageFromReminder();
      assert.equal(job.error, 'no_token');
      assert.match(job.errorDetail, /^searched: page, site-request, \/en\/Magic\/ShoppingCart, .*\/en\/Magic\/Wants, \/en\/Magic · this page: inputs=0 cmtkn-in-html=0/);
      assert.equal(addRequests().length, before, 'nothing sent without a token');
      assert.equal((await items())[MAGE].status, 'missing');
      await shot(widget(page), '11-no-token');
    });
  });

  describe('card pictures', () => {
    it("lets only the extension's own picture requests come from cardmarket.com", async () => {
      const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      const rule = rules.find((r) => (r.condition.requestDomains || []).includes('product-images.s3.cardmarket.com'));
      assert.ok(rule, 'a rule for the picture server');
      assert.deepEqual(rule.condition.initiatorDomains, [extensionId], 'only requests of the extension itself');
      assert.deepEqual(rule.action.requestHeaders, [{ header: 'referer', operation: 'set', value: 'https://www.cardmarket.com/' }]);
    });

    it('keeps a small copy of each picture in the background, so the popup can show it', async () => {
      await sw.evaluate(() => self.cmcs.images.capture());
      const thumbs = await waitFor(async () => {
        const all = (await storage())['cmcs.thumbs'] || {};
        const wanted = Object.values(await items()).map((i) => i.imageUrl).filter(Boolean);
        return wanted.length && wanted.every((url) => all[url] && all[url].src) && all;
      }, 'copies of all pictures');
      for (const thumb of Object.values(thumbs).filter((t) => t.src)) {
        assert.match(thumb.src, /^data:image\/jpeg;base64,/);
        assert.ok(thumb.src.length < 12000, 'copies stay small');
      }
      assert.ok(Object.values(await items()).every((i) => !i.thumb), 'the saved list itself carries no pictures');

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.getByRole('tab', { name: 'Winkelmandje' }).click();
      await waitFor(async () => (await popup.locator('#list img.cmcs-thumb').count()) > 0, 'pictures in popup');
      const sources = await popup.locator('#list img.cmcs-thumb').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));
      assert.ok(sources.every((src) => src.startsWith('data:image/jpeg')), 'popup uses the copies');
      await popup.close();
    });

    it('shows a placeholder instead of a broken image when a picture is refused', async () => {
      const broken = 'https://product-images.s3.cardmarket.com/broken/1/1.jpg';
      await patchItems({ [MAGE]: { imageUrl: broken } });
      await sw.evaluate(() => self.cmcs.images.capture());
      await waitFor(async () => ((await storage())['cmcs.thumbs'] || {})[broken]?.failedAt, 'failed attempt recorded');

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.getByRole('tab', { name: 'Winkelmandje' }).click();
      const row = popup.locator(`#list [data-article-id="${MAGE}"]`);
      await row.locator('.cmcs-thumb--empty').waitFor({ timeout: 10000 });
      assert.equal(await row.locator('img').count(), 0, 'no broken image left');
      assert.equal(await row.locator('.cmcs-thumb--empty').innerText(), 'P');
      await popup.close();
    });
  });

  describe('removing articles yourself', () => {
    before(async () => {
      mock.state.cart = new Map([
        [BOG, 1],
        [MAGE, 1],
        [SOL_RING, 1],
        [EPHEMERATE, 1],
      ]);
      // Start from a clean saved list, so only these four articles are involved.
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {} }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => {
        const all = await items();
        return Object.keys(all).length === 4 && [BOG, MAGE, SOL_RING, EPHEMERATE].every((id) => all[id] && all[id].status === 'in_cart');
      }, 'four articles saved');
    });

    it('stores the numeric seller id of every cart article', async () => {
      const all = await items();
      assert.equal(all[BOG].sellerId, '1001');
      assert.equal(all[SOL_RING].sellerId, '2002');
    });

    it("notices a removal from the site's own request alone, without seeing a click", async () => {
      await page.evaluate((id) => window.cmRemove({ idArticle: id, idSeller: 2002, amount: 1 }), EPHEMERATE);
      await waitFor(async () => !(await items())[EPHEMERATE], 'removed article forgotten');
      assert.equal((await items())[SOL_RING].status, 'in_cart', 'same seller, other article untouched');
    });

    it('forgets an article you remove with its trash button', async () => {
      await page.locator(`table.article-table tr[data-article-id="${MAGE}"] a.trash`).click();
      await waitFor(async () => !(await items())[MAGE], 'removed article forgotten');
      assert.equal(mock.state.cart.has(MAGE), false);
      const all = await items();
      for (const id of [BOG, SOL_RING]) assert.equal(all[id].status, 'in_cart', `${id} untouched`);
      assert.doesNotMatch(await widget(page).innerText(), /Niet meer in je mandje/);
    });

    it("forgets every article of a seller you remove at once", async () => {
      const block = page.locator('section.shipment-block', { hasText: 'Kärtchen-Laden' });
      await block.locator('button.remove-shipment').click();
      await waitFor(async () => {
        const all = await items();
        return !all[SOL_RING] && !all[EPHEMERATE];
      }, 'seller articles forgotten');
      assert.equal((await items())[BOG].status, 'in_cart');
    });

    it("does not take a click in the site's menu as a removal", async () => {
      await sw.evaluate(() => chrome.storage.local.get('cmcs.meta').then(({ 'cmcs.meta': meta = {} }) => chrome.storage.local.set({ 'cmcs.meta': { ...meta, userRemoved: {} } })));
      await page.getByRole('link', { name: 'Purchases' }).click();
      await page.waitForURL(/Orders\/Purchases/);
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual((await storage())['cmcs.meta'].userRemoved || {}, {}, 'nothing marked as removed by you');
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
    });

    it('does not offer to put back what you just bought', async () => {
      const block = page.locator('section.shipment-block', { hasText: 'snowc' });
      await Promise.all([page.waitForNavigation(), block.getByRole('button', { name: 'Commit to purchase' }).click()]);
      await waitFor(async () => !(await items())[BOG], 'bought article forgotten');
      await page.waitForTimeout(1000);
      assert.equal(await widget(page).isVisible(), false, 'no "cart emptied" reminder');
      assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
    });

    it('still remembers articles when Cardmarket empties the cart (and a product link is no removal)', async () => {
      mock.state.cart = new Map([[MAGE, 1]]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[MAGE]?.status === 'in_cart', 'saved');
      // Opening the card's product page from the cart must not count as removing it.
      await Promise.all([page.waitForNavigation(), page.locator(`table.article-table tr[data-article-id="${MAGE}"] td.name a`).click()]);
      mock.state.cart.clear();
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => (await items())[MAGE]?.status === 'missing', 'marked missing, not forgotten');
    });
  });

  /** Click something that starts a refill and wait for that (new) job to finish. */
  const refillVia = async (button) => {
    const previous = (await storage())['cmcs.job'];
    await button.click();
    return waitFor(async () => {
      const j = (await storage())['cmcs.job'];
      return j && j.id !== (previous && previous.id) && (j.state === 'done' || j.state === 'error') && j;
    }, 'job finished');
  };
  const postsFor = (since, id) =>
    addRequests()
      .slice(since)
      .filter((r) => r.path.includes('ShoppingCart_Add') && JSON.parse(new URLSearchParams(r.body).get('idArticle') || '{}')[id]);
  const amountOf = (post, id) => JSON.parse(new URLSearchParams(post.body).get('amount'))[id];
  const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

  describe('reliable refilling', () => {

    it('does not trust a cart page on which a seller block cannot be read', async (t) => {
      t.after(() => (mock.state.brokenSeller = null));
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {} }));
      mock.state.cart = new Map([
        [BOG, 1],
        [MAGE, 1],
        [SOL_RING, 1],
      ]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => Object.values(await items()).filter((i) => i.status === 'in_cart').length === 3, 'three saved');

      mock.state.brokenSeller = 'Kärtchen-Laden';
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await settle();
      assert.equal((await items())[SOL_RING].status, 'in_cart', 'an unreadable block is not "gone"');

      const before = addRequests().length;
      const job = await refillMageFromReminder();
      assert.equal(job.error, 'cart_unreadable');
      assert.match(job.errorDetail, /1 of 2 seller blocks without rows/);
      assert.equal(addRequests().length, before, 'nothing added');
    });

    it('remembers why articles left the cart, and that copies are missing', async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      mock.state.cart = new Map([
        [BOG, 2],
        [MAGE, 1],
        [SOL_RING, 1],
      ]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => {
        const all = await items();
        return all[BOG]?.wantedAmount === 2 && [BOG, MAGE, SOL_RING].every((id) => all[id]?.status === 'in_cart');
      }, 'saved, two copies of the Bog');

      // The seller sold one Bog copy and the Mage; Kärtchen-Laden went on holiday.
      mock.state.cart = new Map([[BOG, 1]]);
      await page.goto(`${CM}/en/Magic`);
      const all = await waitFor(async () => {
        const saved = await items();
        return saved[BOG].status === 'partial' && saved[SOL_RING].status === 'missing' && saved;
      }, 'statuses updated');
      assert.equal(all[BOG].amount, 1);
      assert.equal(all[BOG].wantedAmount, 2);
      assert.equal(all[MAGE].status, 'missing');
      assert.equal(all[MAGE].missingReason, 'single');
      assert.equal(all[SOL_RING].missingReason, 'seller');
      assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '3');

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      // Three to put back, and the Bog copy that is still in the cart (always shown).
      await waitFor(async () => (await popup.locator('#list .cmcs-item').count()) === 4, 'four rows');
      const list = await popup.locator('#list').innerText();
      assert.match(list, /Bojuka Bog[\s\S]*1 van 2 in je mandje/);
      assert.match(list, /Portal Mage[\s\S]*Waarschijnlijk verkocht/);
      assert.match(list, /Sol Ring[\s\S]*Verkoper verdween uit je mandje/);
      // The full sentence is in the tooltip, and in the row once it is opened.
      assert.equal(await popup.locator('[title="Alleen dit artikel verdween, waarschijnlijk verkocht"]').count(), 1);
      await popup.locator(`#list .cmcs-item[data-article-id="${SOL_RING}"] .cmcs-item-line`).click();
      const opened = await popup.locator(`#list .cmcs-item[data-article-id="${SOL_RING}"]`).innerText();
      assert.match(opened, /Alles van deze verkoper verdween uit je mandje/);
      assert.match(opened, /Alleen deze terug[\s\S]*Op Cardmarket/);
      await shot(popup, '12-popup-reasons');
      await popup.close();
    });

    it('puts back only the copies that are missing', async () => {
      const before = addRequests().length;
      const job = await refillVia(widget(page).getByRole('button', { name: /^Zet 3 terug in je mandje/ }));
      assert.equal(job.state, 'done');
      assert.equal(job.added, 3);
      const bogPosts = postsFor(before, BOG);
      assert.equal(bogPosts.length, 1);
      assert.equal(amountOf(bogPosts[0], BOG), '1', 'only the missing copy');
      assert.equal(mock.state.cart.get(BOG), 2);
      const all = await items();
      for (const id of [BOG, MAGE, SOL_RING]) assert.equal(all[id].status, 'in_cart', id);
    });

    it('tries one copy when the seller has fewer left than you want', async (t) => {
      t.after(() => mock.state.stock.clear());
      await closeResult(page);
      mock.state.cart.delete(BOG);
      mock.state.stock.set(BOG, 1);
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => (await items())[BOG].status === 'missing', 'Bog missing');

      const before = addRequests().length;
      // Two copies wanted: the button counts copies.
      const job = await refillVia(widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }));
      assert.equal(job.added, 1);
      assert.deepEqual(postsFor(before, BOG).map((post) => amountOf(post, BOG)), ['2', '1']);
      const bog = (await items())[BOG];
      assert.equal(bog.status, 'partial');
      assert.equal(bog.amount, 1);
      assert.equal(bog.wantedAmount, 2);
    });

    it('keeps an article on the list after an unclear refusal, and gives up after the second', async (t) => {
      t.after(() => mock.state.genericRefusalFor.clear());
      mock.state.cart = new Map([[BOG, 2]]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[MAGE].status === 'missing' && (await items())[SOL_RING].status === 'missing', 'synced');
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      // Cardmarket refuses this one article without a reason, while the other goes back fine.
      mock.state.genericRefusalFor.add(MAGE);

      await page.goto(`${CM}/en/Magic`);
      const job = await refillVia(widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }));
      assert.equal(job.failed, 1);
      assert.equal(job.added, 1);
      let mage = (await items())[MAGE];
      assert.equal(mage.status, 'missing', 'not written off after one unclear refusal');
      assert.equal(mage.lastAttempt.reason, 'unknown');
      assert.equal(mage.lastAttempt.message, 'Something went wrong. Please try again.');

      await closeResult(page);
      await refillVia(widget(page).getByRole('button', { name: /^Zet 1 terug in je mandje/ }));
      mage = (await items())[MAGE];
      assert.equal(mage.status, 'unavailable', 'the second unclear refusal in a row counts as gone');
    });

    it('never writes the whole list off when Cardmarket refuses everything', async (t) => {
      t.after(() => (mock.state.genericRefusal = false));
      mock.state.cart = new Map([[BOG, 2]]);
      await patchItems({ [MAGE]: { status: 'missing', lastAttempt: null }, [SOL_RING]: { status: 'missing', lastAttempt: null } });
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      mock.state.genericRefusal = true;
      await page.goto(`${CM}/en/Magic`);
      for (let round = 0; round < 2; round += 1) {
        await refillVia(widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }));
        await closeResult(page);
      }
      const all = await items();
      assert.equal(all[MAGE].status, 'missing', 'still on the list, to try again later');
      assert.equal(all[SOL_RING].status, 'missing');
    });

    it('takes a lowered amount as what you want', async () => {
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await page.evaluate((id) => window.cmRemove({ idArticle: id, idSeller: 1001, amount: 1 }), BOG);
      const bog = await waitFor(async () => {
        const saved = (await items())[BOG];
        return saved && saved.amount === 1 && saved;
      }, 'Bog synced');
      assert.equal(bog.status, 'in_cart', 'not "partly"');
      assert.equal(bog.wantedAmount, 1);
    });

    it('runs one refill at a time and offers to continue when its tab closes', async (t) => {
      t.after(() => sw.evaluate((delayMs) => chrome.storage.local.set({ 'cmcs.settings': { delayMs } }), DELAY_MS));
      mock.state.cart = new Map([
        [BOG, 1],
        [MAGE, 1],
        [SOL_RING, 1],
        [SOL_KINGDOM, 1],
      ]);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.items': {} }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => Object.values(await items()).filter((i) => i.status === 'in_cart').length === 4, 'four saved');
      mock.state.cart = new Map([[BOG, 1]]);
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => Object.values(await items()).filter((i) => i.status === 'missing').length === 3, 'three missing');
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.settings': { delayMs: 2500 } }));

      const runner = await context.newPage();
      await runner.goto(`${CM}/en/Magic`);
      await widget(runner).getByRole('button', { name: /^Zet 3 terug in je mandje/ }).click();
      await waitFor(async () => (await storage())['cmcs.job']?.done >= 1, 'first article added');

      // A second tab asking to refill now is told to wait.
      const reply = await sw.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({ url });
        const replies = await Promise.all(
          tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'cmcs.refill', articleIds: ['1611110001'] }).catch(() => null)),
        );
        return replies.filter(Boolean);
      }, `${CM}/en/Magic`);
      assert.ok(reply.length >= 2);
      assert.ok(reply.every((r) => r.ok === false && r.error === 'busy'), JSON.stringify(reply));

      await runner.close();
      await waitFor(() => widget(page).getByText('Terugzetten onderbroken').isVisible(), 'interrupted job noticed', 20000);
      await shot(widget(page), '13-interrupted');
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.settings': { delayMs: 300 } }));
      await widget(page).getByRole('button', { name: /^Doorgaan \(\d te gaan\)$/ }).click();
      await waitFor(async () => {
        const j = (await storage())['cmcs.job'];
        return j && j.state === 'done' && j;
      }, 'continued job done');
      for (const id of [MAGE, SOL_RING, SOL_KINGDOM]) assert.equal(mock.state.cart.get(id), 1, `${id} added exactly once`);
      const all = await items();
      for (const id of [MAGE, SOL_RING, SOL_KINGDOM]) assert.equal(all[id].status, 'in_cart', id);
    });

    it("leaves the list alone while you are logged in with another account", async (t) => {
      t.after(async () => {
        mock.state.username = 'tester';
        await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.meta': {} }));
      });
      await closeResult(page);
      assert.equal((await storage())['cmcs.meta'].account, 'tester');
      mock.state.username = 'someone-else';
      mock.state.cart.clear();
      await page.goto(`${CM}/en/Magic`);
      await waitFor(() => widget(page).getByText('Ander Cardmarket-account').isVisible(), 'account notice');
      assert.match(await widget(page).innerText(), /horen bij tester/);
      const all = await items();
      for (const id of [MAGE, SOL_RING, SOL_KINGDOM]) assert.equal(all[id].status, 'in_cart', `${id} untouched`);
      await shot(widget(page), '14-other-account');

      // Putting something back from the popup in the meantime: the job stops at the
      // other account, and the cart it read never ends up in the list.
      await patchItems({ [MAGE]: { status: 'missing' } });
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      const job = await runViaNewTab(popup.getByRole('button', { name: /^Zet 1 terug in je mandje/ }));
      assert.equal(job.error, 'other_account');
      const after = await items();
      assert.equal(after[MAGE].status, 'missing');
      for (const id of [SOL_RING, SOL_KINGDOM]) assert.equal(after[id].status, 'in_cart', `${id} not taken from the other account's empty cart`);
      await popup.close();
      await patchItems({ [MAGE]: { status: 'in_cart' } });
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));

      await widget(page).getByRole('button', { name: 'Voortaan someone-else gebruiken' }).click();
      await waitFor(async () => (await storage())['cmcs.meta'].account === 'someone-else', 'account switched');
    });
  });

  describe('smart refilling', () => {
    const SOL_SAME_SELLER = '1611110003';
    const SOL_SNOWC = '1611110004';
    const SOL_BUDGET = '1611110005';
    const removeRequests = (since) => mock.state.requests.slice(since).filter((r) => r.method === 'POST' && r.path.endsWith('/ShoppingCart_RemoveArticle'));
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      return popup;
    };

    it('tries the rest one by one when a seller batch is refused', async (t) => {
      t.after(() => mock.state.available.set(MAGE, mock.article(MAGE)));
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {} }));
      mock.state.cart = new Map([
        [BOG, 1],
        [MAGE, 1],
        [SOL_RING, 1],
      ]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => Object.values(await items()).filter((i) => i.status === 'in_cart').length === 3, 'three saved');
      mock.state.cart.clear();
      mock.state.available.delete(MAGE);
      await page.goto(`${CM}/en/Magic`);

      const before = addRequests().length;
      const job = await refillVia(widget(page).getByRole('button', { name: /^Zet 3 terug in je mandje/ }));
      assert.equal(job.added, 2);
      assert.equal(job.failed, 1);
      const sent = addRequests()
        .slice(before)
        .map((r) => Object.keys(JSON.parse(new URLSearchParams(r.body).get('idArticle'))).sort().join('+'));
      assert.equal(sent[0], [BOG, MAGE].sort().join('+'), 'first one request for snowc');
      assert.deepEqual(sent.slice(1).sort(), [MAGE, SOL_RING].sort(), 'then the refused Mage alone, and Sol Ring');
      assert.equal(mock.state.cart.get(BOG), 1, 'the Bog that got in with the batch is not added twice');
      const all = await items();
      assert.equal(all[BOG].status, 'in_cart');
      assert.equal(all[SOL_RING].status, 'in_cart');
      assert.equal(all[MAGE].status, 'unavailable');
    });

    it('undoes a refill: what it added leaves the cart again, but stays on the list', async () => {
      const before = mock.state.requests.length;
      await widget(page).getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => (await storage())['cmcs.job']?.undone, 'undone');
      await waitFor(() => widget(page).getByText('2 artikelen weer uit je mandje gehaald.').isVisible(), 'undo notice');
      assert.equal(mock.state.cart.size, 0);
      const removals = removeRequests(before).map((r) => new URLSearchParams(r.body));
      assert.equal(removals.length, 2);
      const bog = removals.find((body) => body.get('idArticle') === BOG);
      assert.equal(bog.get('idSeller'), '1001');
      assert.equal(bog.get(`amount-${BOG}`), '1');
      await waitFor(async () => {
        const all = await items();
        return all[BOG]?.status === 'missing' && all[SOL_RING]?.status === 'missing';
      }, 'back to missing, not forgotten');
    });

    it('finds a replacement for a sold article and swaps it in', async (t) => {
      t.after(() => mock.state.available.set(SOL_RING, mock.article(SOL_RING)));
      mock.state.available.delete(SOL_RING);
      for (const id of [SOL_SAME_SELLER, SOL_SNOWC, SOL_BUDGET]) mock.state.available.set(id, mock.article(id));
      mock.state.cart = new Map([[BOG, 1]]);
      await patchItems({ [SOL_RING]: { status: 'unavailable' }, [MAGE]: { status: 'unavailable' } });
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(() => widget(page).isVisible(), 'cart panel');

      const solRow = widget(page).locator(`.cmcs-item[data-article-id="${SOL_RING}"]`);
      await solRow.getByRole('button', { name: 'Vervanging zoeken' }).click();
      const panel = widget(page).locator('.cmcs-replace');
      await waitFor(async () => (await panel.locator('.cmcs-item').count()) === 3, 'three suggestions');
      const rows = await panel.locator('.cmcs-item').allInnerTexts();
      assert.match(rows[0], /Kärtchen-Laden[\s\S]*Zelfde verkoper · 0,10 € duurder/);
      assert.match(rows[1], /snowc[\s\S]*Verkoper zit al in je mandje: geen extra verzendkosten/);
      assert.match(rows[2], /BudgetCards[\s\S]*Goedkoopste vergelijkbare aanbod · 0,20 € goedkoper/);
      const text = await panel.innerText();
      assert.doesNotMatch(text, /CardKingdomNL|MintCondition/, 'other condition, language or foil is no replacement');
      await shot(widget(page), '15-replacement');

      await panel.locator('.cmcs-item').first().getByRole('button', { name: 'Toevoegen' }).click();
      await waitFor(async () => (await storage())['cmcs.job']?.state === 'done', 'replacement added');
      assert.equal(mock.state.cart.get(SOL_SAME_SELLER), 1);
      const all = await waitFor(async () => {
        const saved = await items();
        return !saved[SOL_RING] && saved[SOL_SAME_SELLER]?.status === 'in_cart' && saved;
      }, 'original swapped for the replacement');
      assert.equal(all[SOL_SAME_SELLER].seller, 'Kärtchen-Laden');
    });

    it('removing an article from the list can be undone', async () => {
      const popup = await openPopup();
      await popup.locator('#tab-cart').click();
      await popup.locator(`#list .cmcs-item[data-article-id="${MAGE}"]`).getByRole('button', { name: 'Verwijderen uit opgeslagen lijst' }).click();
      await waitFor(async () => !(await items())[MAGE], 'removed');
      assert.match(await popup.locator('#toast').innerText(), /“Portal Mage” uit de lijst gehaald\./);
      await popup.locator('#toast').getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => (await items())[MAGE]?.status === 'unavailable', 'restored');
      await popup.close();
    });

    it('exports the list as a spreadsheet', async () => {
      const popup = await openPopup();
      await popup.locator('#tab-cart').click();
      const [download] = await Promise.all([popup.waitForEvent('download'), popup.getByRole('button', { name: 'Download CSV' }).click()]);
      const csv = fs.readFileSync(await download.path(), 'utf8');
      const lines = csv.replace(/^﻿/, '').split('\r\n');
      // In the interface's language, as Excel shows it.
      assert.equal(lines[0], '"Naam";"Uitbreiding";"Nummer";"Conditie";"Taal";"Extra";"Aantal";"Prijs";"Verkoper";"Status";"URL"');
      assert.ok(lines.some((line) => line.startsWith('"Bojuka Bog";"Commander 2018";"238";"NM";"Engels";"";"1";"0,99";"snowc";"In mandje";')), csv);
      await popup.close();
    });

    it('saves what the cart tab shows as a named list, and puts it back later', async () => {
      const popup = await openPopup();
      await popup.locator('#tab-carts').click();
      assert.match(await popup.locator('#carts-empty').innerText(), /Nog geen bewaarde lijsten[\s\S]*Bewaar als lijst…/);
      // Saving happens where the list is: the Cart tab.
      await popup.locator('#tab-cart').click();
      await popup.getByRole('button', { name: 'Bewaar als lijst…' }).click();
      assert.match(await popup.locator('#list-form-meta').innerText(), /^2 artikelen · /);
      await popup.fill('#list-name', 'Commander-deck');
      await popup.locator('#list-form').getByRole('button', { name: 'Bewaren' }).click();
      await waitFor(async () => ((await storage())['cmcs.carts'] || []).length === 1, 'list saved');
      const [saved] = (await storage())['cmcs.carts'];
      assert.equal(saved.name, 'Commander-deck');
      assert.deepEqual(saved.items.map((i) => i.articleId).sort(), [BOG, SOL_SAME_SELLER].sort(), 'unavailable articles are not saved');

      // "Bekijken" in the message opens the list.
      await popup.locator('#toast').getByRole('button', { name: 'Bekijken' }).click();
      const entry = popup.locator(`#carts-list [data-cart-id="${saved.id}"]`);
      await waitFor(async () => (await entry.locator('.cmcs-item').count()) === 2, 'list unfolded with its articles');
      assert.match(await entry.innerText(), /Commander-deck[\s\S]*2 artikelen · 2,58 €/);
      await shot(popup, '16-popup-carts');

      // Rename it.
      await entry.getByRole('button', { name: 'Hernoemen' }).click();
      await entry.locator('input[name="name"]').fill('Commander');
      await entry.locator('input[name="name"]').press('Enter');
      await waitFor(async () => (await storage())['cmcs.carts'][0].name === 'Commander', 'renamed');

      // Later: the list and the cart are empty, the saved list brings both back.
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.items': {} }));
      mock.state.cart.clear();
      const job = await runViaNewTab(popup.getByRole('button', { name: 'In mandje zetten' }));
      assert.equal(job.state, 'done', job.errorDetail);
      assert.equal(mock.state.cart.get(BOG), 1);
      assert.equal(mock.state.cart.get(SOL_SAME_SELLER), 1);
      const all = await items();
      assert.equal(all[BOG].status, 'in_cart');
      assert.equal(all[SOL_SAME_SELLER].status, 'in_cart');

      // Once more: everything is there already, and the popup says so.
      await popup.locator('#tab-carts').click();
      await popup.getByRole('button', { name: 'In mandje zetten' }).click();
      await waitFor(async () => /Alles van deze lijst zit al in je mandje/.test(await popup.locator('#toast').innerText()), 'nothing to do');
      await popup.close();
    });

    it('shows saved lists on the cart page, to save and put back there too', async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      const panel = widget(page);
      await waitFor(() => panel.getByText('Bewaarde lijsten (1)').isVisible(), 'saved lists in the panel');
      assert.match(await panel.locator('.cmcs-saved-list').innerText(), /Commander[\s\S]*2 artikelen/);

      await panel.getByRole('button', { name: 'Bewaar als lijst…' }).click();
      await panel.locator('.cmcs-list-form input').fill('Pauper');
      await panel.locator('.cmcs-list-form').getByRole('button', { name: 'Bewaren' }).click();
      await waitFor(async () => ((await storage())['cmcs.carts'] || []).some((c) => c.name === 'Pauper'), 'saved from the panel');
      await waitFor(() => panel.getByText('Bewaarde lijsten (2)').isVisible(), 'two lists');
    });

    it('deleting a saved list can be undone', async () => {
      const popup = await openPopup();
      await popup.locator('#tab-carts').click();
      const first = popup.locator('#carts-list .saved-cart').first();
      const name = await first.locator('.saved-cart-name').innerText();
      await first.getByRole('button', { name: 'Verwijderen' }).click();
      await waitFor(async () => !(await storage())['cmcs.carts'].some((c) => c.name === name), 'deleted');
      await popup.locator('#toast').getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => (await storage())['cmcs.carts'].some((c) => c.name === name), 'back again');
      await popup.close();
    });
  });

  describe('insight', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('shows when Cardmarket will empty the cart and warns 5 minutes before', async (t) => {
      t.after(() => (mock.state.cartNotice = null));
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {} }));
      mock.state.cart = new Map([
        [BOG, 2],
        [MAGE, 1],
        [SOL_RING, 1],
      ]);
      const at = new Date(Date.now() + 40 * 60 * 1000);
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      mock.state.cartNotice = `Your shopping cart will be emptied at ${hhmm}.`;
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await storage())['cmcs.meta']?.cartExpiry, 'expiry read');
      const expiry = (await storage())['cmcs.meta'].cartExpiry;
      assert.ok(Math.abs(expiry - at.getTime()) < 60 * 1000, 'the time from the notice');
      await waitFor(async () => /Cardmarket leegt je mandje om \d\d:\d\d \(nog (39|40) min\)/.test(await widget(page).innerText()), 'countdown');

      const alarm = await waitFor(() => sw.evaluate(() => chrome.alarms.get('cmcs.expiry')), 'alarm');
      assert.ok(Math.abs(alarm.scheduledTime - (expiry - 5 * 60 * 1000)) < 2000, '5 minutes before');
      assert.equal(await sw.evaluate(() => self.cmcs.warnExpiry()), true);
      const shown = await sw.evaluate(() => new Promise((resolve) => chrome.notifications.getAll(resolve)));
      assert.ok(shown.expiry, JSON.stringify(shown));
      await sw.evaluate(() => chrome.notifications.clear('expiry'));
    });

    it('sums up shipping per seller', async () => {
      const panel = widget(page);
      const toggle = panel.getByRole('button', { name: /2 verkopers · verzending 2,30 € \(38% van het totaal\)/ });
      await toggle.click();
      const rows = await panel.locator('.cmcs-shipping-row').allInnerTexts();
      assert.equal(rows.length, 2);
      assert.match(rows[0], /snowc[\s\S]*2,23 €[\s\S]*3 artikelen · verzending 1,15 € \(34%\)/);
      assert.match(rows[1], /Kärtchen-Laden[\s\S]*1,49 €[\s\S]*1 artikel · verzending 1,15 € \(44%\)/);
      await shot(panel, '17-shipping');
    });

    it('notes offers clearly above the price trend (public price guide)', async (t) => {
      const guide = {
        version: 1,
        createdAt: new Date().toISOString(),
        priceGuides: [
          { idProduct: 361919, idCategory: 1, avg: 0.6, low: 0.3, trend: 0.5, 'trend-foil': 1.2 },
          { idProduct: 723729, idCategory: 1, avg: 0.3, low: 0.1, trend: 0.3, 'trend-foil': 0.2 },
          { idProduct: 1, idCategory: 1, trend: 9.99 },
        ],
      };
      const fetched = [];
      await context.route('https://downloads.s3.cardmarket.com/**', (r) => {
        fetched.push(new URL(r.request().url()).pathname);
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(guide) });
      });
      t.after(async () => {
        await context.unroute('https://downloads.s3.cardmarket.com/**');
        await sw.evaluate(async () => {
          const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
          await chrome.storage.local.set({ 'cmcs.settings': { ...settings, priceTrend: false } });
        });
      });
      await sw.evaluate(async () => {
        const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
        await chrome.storage.local.set({ 'cmcs.settings': { ...settings, priceTrend: true } });
      });
      const status = await waitFor(async () => (await storage())['cmcs.prices'], 'price guide read');
      assert.equal(status.error, null);
      assert.deepEqual(status.games, { Magic: 2 });
      assert.deepEqual(fetched, ['/productCatalog/priceGuide/price_guide_1.json']);
      const all = await items();
      assert.equal(all[BOG].trend.value, 0.5);
      assert.equal(all[MAGE].trend.value, 0.2, 'the foil trend for a foil card');

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      await waitFor(async () => /Bojuka Bog[\s\S]*98% boven trend/.test(await popup.locator('#list').innerText()), 'trend in the list');
      const list = await popup.locator('#list').innerText();
      assert.equal(await popup.locator('[title="Trend 0,50 € · deze aanbieding is 98% duurder"]').count(), 1);
      assert.doesNotMatch(list, /Portal Mage[\s\S]*Trend/, 'five cents above the trend is not worth a note');
      await popup.close();
    });

    it('reads the cart again after 15 minutes, even when the count looks the same', async () => {
      await sw.evaluate(async () => {
        const { 'cmcs.meta': meta } = await chrome.storage.local.get('cmcs.meta');
        meta.cartSync.at = Date.now() - 20 * 60 * 1000;
        await chrome.storage.local.set({ 'cmcs.meta': meta });
      });
      const before = mock.state.requests.length;
      await page.goto(`${CM}/en/Magic`);
      await waitFor(
        () => mock.state.requests.slice(before).some((r) => r.method === 'GET' && r.path === '/en/Magic/ShoppingCart'),
        'cart read again',
      );
    });

    it('can look at the cart every 10 minutes while you are away (off by default)', async () => {
      assert.equal(await sw.evaluate(() => chrome.alarms.get('cmcs.away')), undefined, 'off by default');
      await sw.evaluate(async () => {
        const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
        await chrome.storage.local.set({ 'cmcs.settings': { ...settings, awayChecks: true } });
      });
      const alarm = await waitFor(() => sw.evaluate(() => chrome.alarms.get('cmcs.away')), 'away alarm');
      assert.equal(alarm.periodInMinutes, 10);

      // Twenty minutes later the cart was emptied; the check notices it.
      mock.state.cart.clear();
      await sw.evaluate(async () => {
        const { 'cmcs.meta': meta } = await chrome.storage.local.get('cmcs.meta');
        meta.cartSync.at = Date.now() - 20 * 60 * 1000;
        await chrome.storage.local.set({ 'cmcs.meta': meta });
      });
      // Only while you are at the computer (whether this test machine is in use does not matter).
      assert.equal(await sw.evaluate(() => self.cmcs.awayCheck({ idleState: async () => 'idle' })), false, 'not while you are away');
      assert.equal(await sw.evaluate(() => self.cmcs.awayCheck({ idleState: async () => 'active' })), true);
      await waitFor(async () => (await items())[BOG].status === 'missing', 'emptied cart noticed');

      await sw.evaluate(async () => {
        const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
        await chrome.storage.local.set({ 'cmcs.settings': { ...settings, awayChecks: false } });
      });
      await waitFor(async () => (await sw.evaluate(() => chrome.alarms.get('cmcs.away'))) === undefined, 'alarm gone');
    });

    it('forgets articles that have been unavailable for a month', async () => {
      await patchItems({
        [SOL_RING]: { status: 'unavailable', lastAttempt: { at: Date.now() - 40 * DAY, ok: false }, missingSince: Date.now() - 40 * DAY, lastSeenInCartAt: Date.now() - 41 * DAY },
        [MAGE]: { status: 'unavailable', lastAttempt: { at: Date.now() - 2 * DAY, ok: false } },
      });
      assert.equal(await sw.evaluate(() => self.cmcs.pruneStale()), 1);
      const all = await items();
      assert.equal(all[SOL_RING], undefined);
      assert.ok(all[MAGE], 'recent ones stay');
    });
  });

  describe('several games in one cart', () => {
    const PIKACHU = '1622220000';

    it('saves the articles of every game from the one cart', async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {} }));
      mock.state.cart = new Map([
        [BOG, 1],
        [PIKACHU, 1],
        [SOL_RING, 1],
      ]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      const all = await waitFor(async () => {
        const saved = await items();
        return Object.values(saved).filter((i) => i.status === 'in_cart').length === 3 && saved;
      }, 'three saved');
      assert.equal(all[PIKACHU].game, 'Pokemon');
      assert.equal(all[PIKACHU].seller, 'snowc');
      assert.equal(all[BOG].game, 'Magic');
      await waitFor(async () => /3 artikelen in je mandje zijn opgeslagen/.test(await widget(page).innerText()), 'all games in the panel');
    });

    it('notices a Pokémon card leaving the cart while on a Magic page, and puts it back', async () => {
      mock.state.cart.delete(BOG);
      mock.state.cart.delete(PIKACHU);
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => {
        const saved = await items();
        return saved[BOG].status === 'missing' && saved[PIKACHU].status === 'missing';
      }, 'both missing');
      assert.equal((await items())[PIKACHU].missingReason, 'seller');

      const before = addRequests().length;
      const job = await refillVia(widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }));
      assert.equal(job.state, 'done', job.errorDetail);
      assert.equal(job.added, 2);
      const paths = addRequests()
        .slice(before)
        .map((r) => r.path)
        .sort();
      assert.deepEqual(paths, [
        '/en/Magic/AjaxAction/ShoppingCart_Add_AddArticlesFromUserOffers',
        '/en/Pokemon/AjaxAction/ShoppingCart_Add_AddArticlesFromUserOffers',
      ]);
      assert.equal(mock.state.cart.get(PIKACHU), 1);
      assert.equal(mock.state.cart.get(BOG), 1);
      const all = await items();
      assert.equal(all[PIKACHU].status, 'in_cart');
      assert.equal(all[BOG].status, 'in_cart');
    });

    it('the popup shows all games together, or one game', async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      const select = popup.locator('#game');
      await waitFor(() => select.isVisible(), 'game picker');
      assert.equal(await select.inputValue(), '*');
      assert.deepEqual(await select.locator('option').allInnerTexts(), ['Alle spellen', 'Magic', 'Pokémon']);
      assert.match(await popup.locator('#summary').innerText(), /Alles zit in je mandje/);
      await waitFor(async () => (await popup.locator('#list .cmcs-item').count()) === 3, 'all three');
      assert.match(await popup.locator(`#list .cmcs-item[data-article-id="${PIKACHU}"]`).innerText(), /Pikachu[\s\S]*Base Set · NM · Engels · Pokémon/);
      // One seller, both games, under one header.
      const sellers = await popup.locator('#list .cmcs-seller-name').allInnerTexts();
      assert.deepEqual(sellers, ['Kärtchen-Laden', 'snowc']);
      await shot(popup, '18-popup-all-games');

      await select.selectOption('Pokemon');
      await waitFor(async () => (await popup.locator('#list .cmcs-item').count()) === 1, 'only Pokémon');
      await select.selectOption('*');
      await popup.close();
    });

    it('puts back only the games you choose', async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      mock.state.cart = new Map([[SOL_RING, 1]]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => {
        const saved = await items();
        return saved[BOG].status === 'missing' && saved[PIKACHU].status === 'missing';
      }, 'both missing');
      const panel = widget(page);
      await waitFor(() => panel.getByRole('button', { name: 'Pokémon (1)' }).isVisible(), 'game chips');
      await shot(panel, '19-game-chips');
      await panel.getByRole('button', { name: 'Magic (1)' }).click();
      assert.equal(await panel.getByRole('button', { name: 'Magic (1)' }).getAttribute('aria-pressed'), 'false');
      const job = await refillVia(panel.getByRole('button', { name: /^Zet 1 terug in je mandje.*3,50 €$/ }));
      assert.equal(job.added, 1);
      assert.equal(mock.state.cart.get(PIKACHU), 1);
      assert.equal(mock.state.cart.has(BOG), false, 'Magic was left out');

      // On other pages the reminder offers one game too.
      await page.goto(`${CM}/en/Pokemon`);
      await closeResult(page);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      mock.state.cart.delete(PIKACHU);
      await page.goto(`${CM}/en/Magic`);
      await waitFor(() => widget(page).getByText('Of alleen:').isVisible(), 'only one game');
      assert.ok(await widget(page).getByRole('button', { name: 'Pokémon (1)' }).isVisible());
    });
  });

  describe('removing articles yourself, whatever request the site uses', () => {
    const PIKACHU = '1622220000';
    const freshCart = async (style) => {
      mock.state.removeStyle = style;
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {} }));
      mock.state.cart = new Map([
        [BOG, 1],
        [MAGE, 1],
        [PIKACHU, 1],
      ]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => Object.values(await items()).filter((i) => i.status === 'in_cart').length === 3, 'three saved');
    };
    after(() => (mock.state.removeStyle = 'plain'));

    it('reads a removal hidden in an obfuscated args request', async () => {
      await freshCart('args');
      // No click on the page: only the request itself can tell.
      await page.evaluate((id) => document.querySelector(`table.article-table tr[data-article-id="${id}"] a.trash`).click(), MAGE);
      await waitFor(async () => !(await items())[MAGE], 'removed article forgotten');
      assert.equal(mock.state.cart.has(MAGE), false);
      const all = await items();
      assert.equal(all[BOG].status, 'in_cart');
      assert.equal(all[PIKACHU].status, 'in_cart');
    });

    it('sees a removal it cannot read on the cart page itself, right after your click', async () => {
      await freshCart('opaque');
      await page.locator(`table.article-table tr[data-article-id="${PIKACHU}"] a.trash`).click();
      await waitFor(async () => !(await items())[PIKACHU], 'removed Pokémon card forgotten');
      const all = await items();
      assert.equal(all[BOG].status, 'in_cart');
      assert.equal(all[MAGE].status, 'in_cart');
    });

    it('does not take a change you did not make as a removal', async () => {
      await page.goto(`${CM}/en/Magic/ShoppingCart`); // nothing clicked on this page yet
      await page.evaluate((id) => window.cmOp(id, 1), BOG);
      await waitFor(async () => (await items())[BOG]?.status === 'missing', 'marked missing, not forgotten');
    });
  });

  describe('the popup does what the panel does', () => {
    const SOL_SAME_SELLER = '1611110003';
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      return popup;
    };

    before(async () => {
      // A known list: the Bog and the Mage were in the cart, Cardmarket emptied it.
      for (const id of [BOG, MAGE]) mock.state.available.set(id, mock.article(id));
      mock.state.cart = new Map([[BOG, 1], [MAGE, 1]]);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {}, 'cmcs.favorites': {} }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[MAGE]?.status === 'in_cart', 'saved');
      mock.state.cart.clear();
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => (await items())[BOG]?.status === 'missing' && (await items())[MAGE]?.status === 'missing', 'emptied');
    });

    it('lets you untick what should not go back', async () => {
      const popup = await openPopup();
      await popup.getByRole('checkbox', { name: 'Portal Mage' }).uncheck();
      const job = await runViaNewTab(popup.getByRole('button', { name: /^Zet 1 terug in je mandje/ }));
      assert.equal(job.added, 1);
      assert.deepEqual([...mock.state.cart.keys()], [BOG]);
      assert.equal((await items())[MAGE].status, 'missing', 'the unticked one stays out');
      await popup.close();
    });

    it('undoes a refill from the popup, through an open Cardmarket tab', async () => {
      // A fresh result the popup has not shown yet (it shows a result that went right once).
      await sw.evaluate(() => chrome.storage.local.get('cmcs.job').then(({ 'cmcs.job': job }) => chrome.storage.local.set({ 'cmcs.job': { ...job, id: `${job.id}-again`, acknowledged: false } })));
      const popup = await openPopup();
      await popup.locator('#job').getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => /1 artikel weer uit je mandje gehaald/.test(await popup.locator('#toast').innerText()), 'undone');
      assert.equal(mock.state.cart.size, 0);
      assert.equal((await items())[BOG].status, 'missing', 'still on the list');
      await popup.close();
    });

    it('says when Cardmarket empties the cart, and when you are logged in as someone else', async (t) => {
      t.after(() => sw.evaluate(() => chrome.storage.local.set({ 'cmcs.meta': {} })));
      await sw.evaluate((at) => chrome.storage.local.set({ 'cmcs.meta': { account: 'tester', accountMismatch: 'someone-else', cartExpiry: at } }), Date.now() + 30 * 60 * 1000);
      const popup = await openPopup();
      await waitFor(async () => /Cardmarket leegt je mandje om/.test(await popup.locator('#summary').innerText()), 'expiry');
      assert.match(await popup.locator('#account').innerText(), /Ander Cardmarket-account[\s\S]*horen bij tester/);
      await popup.getByRole('button', { name: 'Voortaan someone-else gebruiken' }).click();
      await waitFor(async () => (await storage())['cmcs.meta'].account === 'someone-else', 'account switched');
      await popup.close();
    });

    it('finds a replacement from the popup: the cart page opens with the suggestions', async (t) => {
      t.after(async () => {
        mock.state.available.set(SOL_RING, mock.article(SOL_RING));
        mock.state.available.delete(SOL_SAME_SELLER);
      });
      mock.state.available.delete(SOL_RING);
      mock.state.available.set(SOL_SAME_SELLER, mock.article(SOL_SAME_SELLER));
      await sw.evaluate(async (sol) => {
        const { 'cmcs.items': all } = await chrome.storage.local.get('cmcs.items');
        all[sol.articleId] = sol;
        await chrome.storage.local.set({ 'cmcs.items': all, 'cmcs.job': null });
      }, {
        articleId: SOL_RING, productId: '500100', game: 'Magic', lang: 'en', name: 'Sol Ring', expansion: 'Commander Masters',
        productUrl: SOL_RING_URL, condition: 2, conditionLabel: 'NM', language: 1, languageLabel: 'English', foil: false, extras: [],
        price: 1.49, amount: 1, wantedAmount: 1, seller: 'Kärtchen-Laden', sellerUrl: `${CM}/en/Magic/Users/K%C3%A4rtchen-Laden`, sellerId: '2002',
        status: 'unavailable', lastAttempt: { at: Date.now(), ok: false, reason: 'sold', message: 'This article is no longer available.' },
      });
      const popup = await openPopup();
      const opened = context.waitForEvent('page');
      await popup.locator(`#list [data-article-id="${SOL_RING}"]`).getByRole('button', { name: 'Vervanging zoeken' }).click();
      const tab = await opened;
      // The first load of a tab the extension opens slips past the mock (and fails,
      // offline): ask Chrome which page the tab was opened for, then load it again.
      const wanted = new RegExp(`/ShoppingCart#cmcs-replace=${SOL_RING}$`);
      await waitFor(async () => (await sw.evaluate(() => chrome.tabs.query({}))).some((t) => wanted.test(t.pendingUrl || t.url || '')), 'the cart page with the replacement');
      await tab.goto(`${CM}/en/Magic/ShoppingCart#cmcs-replace=${SOL_RING}`);
      await waitFor(async () => (await widget(tab).locator('.cmcs-replace .cmcs-item').count()) > 0, 'suggestions shown');
      assert.match(await widget(tab).locator('.cmcs-replace').innerText(), /Kärtchen-Laden/);
      await tab.close();
      await popup.close();
    });

    it('puts several favourites in the cart at once, skipping what is in it already', async () => {
      const favs = [SOL_KINGDOM, SOL_SAME_SELLER, BOG].map((id) => mock.article(id));
      mock.state.available.set(SOL_SAME_SELLER, mock.article(SOL_SAME_SELLER));
      // The Bog is a favourite that is in the cart already.
      mock.state.cart.set(BOG, 1);
      await patchItems({ [BOG]: { status: 'in_cart', amount: 1, wantedAmount: 1 } });
      await sw.evaluate(async (list) => {
        const favorites = {};
        for (const a of list) {
          favorites[a.articleId] = {
            articleId: a.articleId, productId: a.productId, game: a.game, lang: 'en', name: a.name, expansion: a.expansion,
            productUrl: `https://www.cardmarket.com/en/Magic/Products/Singles/${a.expansionSlug}/${a.cardSlug}`,
            condition: a.condition, conditionLabel: a.conditionLabel, language: a.language, languageLabel: a.languageLabel,
            foil: a.foil, extras: [], price: a.price, seller: a.seller, favoritedAt: Date.now(), unavailable: false,
          };
        }
        await chrome.storage.local.set({ 'cmcs.favorites': favorites, 'cmcs.job': null });
      }, favs);
      const popup = await openPopup();
      await popup.locator('#tab-fav').click();
      await popup.locator('#fav-list .cmcs-section-head').getByRole('button', { name: 'Alles selecteren' }).click();
      assert.match(await popup.locator('#fav-list .cmcs-section-head').innerText(), /3 favorieten · 3 geselecteerd · 1 al in je mandje/);
      const job = await runViaNewTab(popup.locator('#foot').getByRole('button', { name: /^Zet 2 in je mandje/ }));
      assert.equal(job.articleIds.length, 2, 'one job for both, without the one in the cart');
      assert.equal(job.added, 2);
      assert.equal(mock.state.cart.get(SOL_KINGDOM), 1);
      assert.equal(mock.state.cart.get(SOL_SAME_SELLER), 1);
      await popup.close();
    });

    it('takes favourites that never went to the cart off the list again', async () => {
      const removed = await sw.evaluate(async () => {
        const { 'cmcs.items': all } = await chrome.storage.local.get('cmcs.items');
        all['9100000001'] = { articleId: '9100000001', name: 'Waiting favourite', game: 'Magic', status: 'missing', viaFavorite: true, missingSince: Date.now() - 10 * 60 * 1000 };
        all['9100000002'] = { articleId: '9100000002', name: 'Just queued', game: 'Magic', status: 'missing', viaFavorite: true, missingSince: Date.now() };
        await chrome.storage.local.set({ 'cmcs.items': all, 'cmcs.job': null });
        return self.CMCS.store.sweepUntriedFavorites(null);
      });
      assert.deepEqual(removed, ['9100000001'], 'only the one that waited too long');
      await patchItems({ '9100000002': { missingSince: 0 } });
      await sw.evaluate(() => self.CMCS.store.sweepUntriedFavorites(null));
      assert.equal((await items())['9100000002'], undefined);
    });
  });

  describe('ignoring what is gone', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click(); // the popup remembers the last tab
      return popup;
    };
    const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));

    before(async () => {
      // Three articles in the cart; then one copy of the Bog, the Mage and the Ephemerate leave it.
      for (const id of [BOG, MAGE, EPHEMERATE]) mock.state.available.set(id, mock.article(id));
      mock.state.cart = new Map([[BOG, 2], [MAGE, 1], [EPHEMERATE, 1]]);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {}, 'cmcs.favorites': {} }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[EPHEMERATE]?.status === 'in_cart', 'saved');
      mock.state.cart = new Map([[BOG, 1]]);
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => {
        const all = await items();
        return all[BOG]?.status === 'partial' && all[MAGE]?.status === 'missing' && all[EPHEMERATE]?.status === 'missing';
      }, 'partly gone');
    });

    it('ignores everything from the reminder: no badge, no reminder, and it can be undone', async () => {
      await waitFor(async () => /Je winkelmandje is geleegd/.test(await widget(page).innerText()), 'reminder');
      await waitFor(async () => (await badge()) === '3', 'badge 3');
      await widget(page).getByRole('button', { name: 'Negeren', exact: true }).click();

      const all = await waitFor(async () => {
        const now = await items();
        return now[MAGE].status === 'ignored' && now[EPHEMERATE].status === 'ignored' && now;
      }, 'ignored');
      assert.equal(all[BOG].status, 'in_cart', 'what is in the cart is what you want now');
      assert.equal(all[BOG].wantedAmount, 1);
      await waitFor(async () => (await badge()) === '', 'no badge');
      await waitFor(async () => /3 artikelen genegeerd/.test(await widget(page).locator('.cmcs-strip').innerText()), 'strip');
      await shot(widget(page), '20-ignored-strip');

      await widget(page).locator('.cmcs-strip').getByRole('button', { name: 'Ongedaan maken' }).click();
      const back = await waitFor(async () => {
        const now = await items();
        return now[MAGE].status === 'missing' && now[EPHEMERATE].status === 'missing' && now[BOG].status === 'partial' && now;
      }, 'undone');
      assert.equal(back[BOG].wantedAmount, 2);
      await waitFor(async () => (await badge()) === '3', 'badge back');
      await waitFor(async () => /Je winkelmandje is geleegd/.test(await widget(page).innerText()), 'reminder back');
    });

    it('ignores one article in the panel, keeps it under "Ignored", and counts it again once it is back in the cart', async () => {
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      const panel = widget(page);
      await waitFor(() => panel.locator(`.cmcs-item[data-article-id="${MAGE}"]`).isVisible(), 'the Mage in the panel');
      await panel.locator(`.cmcs-item[data-article-id="${MAGE}"] .cmcs-item-line`).click();
      await shot(panel, '21-row-with-ignore');
      await panel.locator(`.cmcs-item[data-article-id="${MAGE}"]`).getByRole('button', { name: 'Negeren', exact: true }).click();
      await waitFor(async () => (await items())[MAGE].status === 'ignored', 'ignored');
      await waitFor(async () => (await badge()) === '2', 'badge without it');
      assert.match(await panel.locator('.cmcs-section-head', { hasText: 'Genegeerd' }).innerText(), /Genegeerd \(1\)/);
      assert.equal(await panel.locator(`.cmcs-item[data-article-id="${MAGE}"]`).count(), 0, 'folded away');
      await panel.locator('.cmcs-section-head', { hasText: 'Genegeerd' }).getByRole('button', { name: 'Toon' }).click();
      await waitFor(() => panel.locator(`.cmcs-item--ignored[data-article-id="${MAGE}"]`).isVisible(), 'listed under Ignored');
      await shot(panel, '22-ignored-section');

      // Reading the cart again leaves it alone…
      await page.reload();
      await waitFor(() => widget(page).isVisible(), 'panel');
      assert.equal((await items())[MAGE].status, 'ignored');
      // …until it is in the cart again.
      mock.state.cart.set(MAGE, 1);
      await page.reload();
      const mage = await waitFor(async () => (await items())[MAGE]?.status === 'in_cart' && (await items())[MAGE], 'back in the cart');
      assert.equal(mage.ignoredAt, null);
    });

    it('ignores the ticked articles from the popup, one undo for several', async () => {
      const popup = await openPopup();
      await popup.getByRole('checkbox', { name: 'Bojuka Bog' }).uncheck();
      await popup.locator('#foot').getByRole('button', { name: 'Negeer 1' }).click();
      await waitFor(async () => (await items())[EPHEMERATE].status === 'ignored', 'the ticked one ignored');
      assert.equal((await items())[BOG].status, 'partial', 'the unticked one stays');
      await waitFor(async () => /“Ephemerate” genegeerd\./.test(await popup.locator('#toast').innerText()), 'toast');
      assert.match(await popup.locator('#list .cmcs-section-head', { hasText: 'Genegeerd' }).innerText(), /Genegeerd \(1\)/);

      // The Bog is listed twice: the copy that can go back, and the one in the cart.
      const bog = popup.locator(`#list .cmcs-item--partial[data-article-id="${BOG}"]`);
      await bog.locator('.cmcs-item-line').click();
      await shot(popup, '23-popup-row-with-ignore');
      await bog.getByRole('button', { name: 'Negeren', exact: true }).click();
      await waitFor(async () => (await items())[BOG].status === 'in_cart', 'the Bog: what is in the cart is enough');
      await waitFor(async () => /2 artikelen genegeerd\./.test(await popup.locator('#toast').innerText()), 'counted together');
      await waitFor(async () => (await badge()) === '', 'nothing left to put back');
      await shot(popup, '24-popup-ignored');

      await popup.locator('#toast').getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => {
        const now = await items();
        return now[BOG].status === 'partial' && now[BOG].wantedAmount === 2 && now[EPHEMERATE].status === 'missing';
      }, 'both undone');
      await popup.close();
    });

    it('offers to ignore a saved offer that is not on its page any more', async (t) => {
      t.after(() => mock.state.available.set(EPHEMERATE, mock.article(EPHEMERATE)));
      mock.state.available.delete(EPHEMERATE);
      await page.goto(`${CM}/en/Magic/Products/Singles/Modern-Horizons/Ephemerate#articleRow${EPHEMERATE}`);
      await waitFor(async () => /Aanbieding niet gevonden/.test(await widget(page).innerText()), 'notice');
      await shot(widget(page), '25-offer-not-found');
      await widget(page).getByRole('button', { name: 'Negeren', exact: true }).click();
      await waitFor(async () => (await items())[EPHEMERATE].status === 'ignored', 'ignored');
      await waitFor(async () => /“Ephemerate” genegeerd\./.test(await widget(page).innerText()), 'said so');
      await widget(page).getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => (await items())[EPHEMERATE].status === 'missing', 'undone');
    });

    it('forgets ignored articles after a month', async () => {
      const long = Date.now() - 40 * DAY;
      await patchItems({
        [EPHEMERATE]: { status: 'ignored', ignoredAt: long, missingSince: long, lastSeenInCartAt: long, lastAttempt: null },
        [MAGE]: { status: 'ignored', ignoredAt: Date.now() - 2 * DAY },
      });
      assert.equal(await sw.evaluate(() => self.cmcs.pruneStale()), 1);
      const all = await items();
      assert.equal(all[EPHEMERATE], undefined);
      assert.ok(all[MAGE], 'recently ignored ones stay');
    });
  });

  describe('estimated PSA value (Pokémon)', () => {
    const PIKACHU = '1622220000';
    const API = 'https://www.pokemonpricetracker.com/**';
    const requests = [];
    const card = (number, set, grades) => ({ name: 'Pikachu', cardNumber: number, setName: set, tcgPlayerId: 42, ebay: { salesByGrade: grades } });
    const answer = {
      data: [
        card('60/102', 'Jungle', { psa9: { count: 3, medianPrice: 999 } }), // another Pikachu: never its price
        card('58/102', 'Base Set', {
          psa10: { count: 12, medianPrice: 210, smartMarketPrice: { price: 205, confidence: 'high' } },
          psa9: { count: 30, medianPrice: 80 },
          psa8: { count: 20, medianPrice: 45.4 },
          psa7: { count: 5, medianPrice: 30 },
          psa6: { count: 2, medianPrice: 20 },
        }),
      ],
    };
    const setSettings = (patch) =>
      sw.evaluate(async (p) => {
        const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
        await chrome.storage.local.set({ 'cmcs.settings': { ...settings, ...p } });
      }, patch);
    const psa = async () => (await storage())['cmcs.psa'];

    before(async () => {
      await context.route(API, (r) => {
        const request = r.request();
        requests.push({ url: request.url(), auth: request.headers().authorization });
        if (request.headers().authorization !== 'Bearer test-key') {
          return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Invalid API key"}' });
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
      });
      for (const id of [PIKACHU, BOG]) mock.state.available.set(id, mock.article(id));
      mock.state.cart = new Map([[PIKACHU, 1], [BOG, 1]]);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {}, 'cmcs.psa': {} }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[PIKACHU]?.status === 'in_cart', 'the Pikachu saved');
    });
    after(async () => {
      await context.unroute(API);
      await setSettings({ psaEstimate: false, pptApiKey: '' });
    });

    it('translates Cardmarket conditions into a PSA grade and band', async () => {
      const bands = await sw.evaluate(() =>
        ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'].map((code) => {
          const band = self.CMCS.store.psaBand({ conditionLabel: code });
          return `${code} ${band.grade} ${band.low}-${band.high}`;
        }),
      );
      assert.deepEqual(bands, ['MT 9 8-10', 'NM 8 7-10', 'EX 6 5-7', 'GD 4 3-5', 'LP 3 2-4', 'PL 2 1-3', 'PO 1 1-2']);
      assert.equal(await sw.evaluate(() => self.CMCS.store.psaBand({ conditionLabel: null })), null, 'sealed products have no condition');
      // Only the same card counts: the same number, never just the same name.
      const picked = await sw.evaluate((cards) => {
        const { pickMatch } = self.cmcs.psa;
        const pikachu = { name: 'Pikachu', number: '58', expansion: 'Base Set' };
        return [pickMatch(pikachu, cards)?.cardNumber ?? null, pickMatch({ ...pikachu, number: '25' }, cards)?.cardNumber ?? null];
      }, answer.data);
      assert.deepEqual(picked, ['58/102', null]);
    });

    it('shows the estimated PSA value in the popup and in the cart, from one look-up', async () => {
      await setSettings({ psaEstimate: true, pptApiKey: 'test-key' });
      const saved = await waitFor(async () => (await psa())?.status?.known === 1 && (await psa()), 'PSA prices fetched');
      assert.equal(requests.length, 1, 'one search for the one Pokémon card; the Magic card is not looked up');
      const url = new URL(requests[0].url);
      assert.equal(requests[0].auth, 'Bearer test-key');
      assert.equal(url.searchParams.get('search'), 'Pikachu 58');
      assert.equal(url.searchParams.get('includeEbay'), 'true');
      assert.deepEqual(Object.values(saved.cards)[0].grades['10'], { price: 205, count: 12 });

      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      const line = popup.locator(`#list .cmcs-item[data-article-id="${PIKACHU}"] .cmcs-psa`);
      await waitFor(() => line.isVisible(), 'PSA line in the popup');
      assert.equal(await line.innerText(), 'PSA 8 ≈ $45 · 7–10: $30–$205');
      assert.match(await line.getAttribute('title'), /conditie NM: waarschijnlijk PSA 8 \(PSA 7–10\)[\s\S]*PSA 10 \$205 \(12×\)[\s\S]*Gevonden als: Pikachu · Base Set · 58\/102/);
      assert.equal(await popup.locator(`#list .cmcs-item[data-article-id="${BOG}"] .cmcs-psa`).count(), 0, 'not for Magic cards');
      await shot(popup, '26-popup-psa');
      await popup.close();

      await page.reload();
      const label = page.locator(`tr[data-article-id="${PIKACHU}"] cmcs-psa span`).first();
      await waitFor(() => label.isVisible(), 'PSA label in the cart');
      assert.equal(await label.innerText(), 'PSA 8 ≈ $45 · 7–10: $30–$205');
      assert.equal(await page.locator(`tr[data-article-id="${BOG}"] cmcs-psa`).count(), 0);

      // Kept for a week: looking again costs no credits.
      await sw.evaluate(() => self.cmcs.psa.refresh({ force: true }));
      assert.equal(requests.length, 1);
    });

    it('says when the key is refused, and forgets the prices when switched off', async () => {
      await sw.evaluate(() => chrome.storage.local.remove('cmcs.psa'));
      await setSettings({ pptApiKey: 'wrong-key' });
      await waitFor(async () => (await psa())?.status?.error === 'key', 'refused');
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
      await waitFor(async () => /weigert de sleutel/.test(await options.locator('#psaStatus').innerText()), 'said in the settings');
      await shot(options, '27-options-psa');

      await setSettings({ pptApiKey: 'test-key' });
      await waitFor(async () => (await psa())?.status?.known === 1, 'fetched with the right key');
      await options.locator('#psaEstimate').uncheck();
      await waitFor(async () => !(await psa()), 'forgotten');
      await options.close();
    });
  });

  describe('nothing stays behind', () => {
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      return popup;
    };
    const job = async () => (await storage())['cmcs.job'];

    before(async () => {
      // Only this tab: another Cardmarket tab or an open popup may see (and so close) a result first.
      for (const other of context.pages()) if (other !== page) await other.close();
      for (const id of [BOG, MAGE, SOL_RING]) mock.state.available.set(id, mock.article(id));
      mock.state.cart = new Map([[BOG, 1], [MAGE, 1]]);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.meta': {}, 'cmcs.items': {}, 'cmcs.favorites': {} }));
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[MAGE]?.status === 'in_cart', 'saved');
      mock.state.cart.clear();
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => (await items())[MAGE]?.status === 'missing', 'emptied');
    });

    it('says a refill that went fully right once, in a strip, and then it is gone', async () => {
      await widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }).click();
      await waitFor(async () => /2 artikelen terug in je mandje\./.test(await widget(page).locator('.cmcs-strip').innerText().catch(() => '')), 'strip');
      assert.equal(await widget(page).locator('[data-view="summary"]').count(), 0, 'not a view that stays');
      await waitFor(async () => (await job())?.acknowledged === true, 'closed for the other pages and the popup');
      await waitFor(async () => !(await widget(page).isVisible()), 'gone after the strip', 12000);
    });

    it('on the cart page the result stays on top through the reload, until you close it', async () => {
      mock.state.cart.clear();
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await widget(page).getByRole('button', { name: /^Zet 2 terug in je mandje/ }).click();
      const banner = widget(page).locator('.cmcs-result');
      // The page reloads after a refill; the result is on top of the cart view, not instead of it.
      await page.waitForEvent('load');
      await waitFor(async () => /2 artikelen terug in je mandje\./.test(await banner.innerText().catch(() => '')), 'result on top');
      assert.match(await widget(page).innerText(), /in je mandje zijn opgeslagen/, 'the cart view underneath');
      // Seen: closed for the other pages, but it stays here until you close it.
      await waitFor(async () => (await job())?.acknowledged === true, 'seen', 10000);
      await page.waitForTimeout(300);
      assert.ok(await banner.isVisible(), 'still on top');
      await shot(widget(page), '28-result-on-top');
      await banner.getByRole('button', { name: 'Sluiten' }).click();
      await waitFor(async () => (await banner.count()) === 0, 'closed');
    });

    it('closes the replacement suggestions again', async () => {
      // The Mage was sold (and left the cart).
      mock.state.cart.delete(MAGE);
      await patchItems({ [MAGE]: { status: 'unavailable', lastAttempt: { at: Date.now(), ok: false, reason: 'sold', message: 'Sold' } } });
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      const row = widget(page).locator(`.cmcs-item[data-article-id="${MAGE}"]`);
      const replace = widget(page).locator('.cmcs-replace');
      await widget(page).getByRole('button', { name: 'Vervanging zoeken' }).click();
      await waitFor(() => replace.isVisible(), 'suggestions open');
      await widget(page).getByRole('button', { name: 'Verberg vervanging' }).click();
      await waitFor(async () => (await replace.count()) === 0, 'closed with the link');
      await widget(page).getByRole('button', { name: 'Vervanging zoeken' }).click();
      await waitFor(() => replace.isVisible(), 'open again');
      await replace.getByRole('button', { name: 'Sluiten' }).click();
      await waitFor(async () => (await replace.count()) === 0, 'closed with ×');
      assert.ok(await row.isVisible());
    });

    it('a row opened in the popup does not stay open in another tab', async () => {
      await patchItems({ [BOG]: { status: 'missing' } });
      const popup = await openPopup();
      await popup.locator(`#list .cmcs-item[data-article-id="${BOG}"] .cmcs-item-line`).click();
      assert.equal(await popup.locator('#list .cmcs-item--open').count(), 1);
      await popup.locator('#tab-fav').click();
      await popup.locator('#tab-cart').click();
      assert.equal(await popup.locator('#list .cmcs-item--open').count(), 0);
      await popup.close();
    });
  });

  describe('the same in all your browsers', () => {
    const LIST_ID = 'cart-sync-test';
    const NEW_FAV = '1611110004';
    const remote = () => sw.evaluate(() => chrome.storage.sync.get(null));
    const merge = () => sw.evaluate(() => self.cmcs.sync.merge());
    const setSync = (on) =>
      sw.evaluate(async (value) => {
        const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
        await chrome.storage.local.set({ 'cmcs.settings': { ...settings, cloudSync: value } });
      }, on);
    /** Another browser of the same person writes to the synced copy. */
    const elsewhere = (entries) => sw.evaluate((e) => chrome.storage.sync.set(e), entries);
    const favorite = (id) => {
      const a = mock.article(id);
      return {
        articleId: id, productId: a.productId, game: 'Magic', lang: 'en', name: a.name, expansion: a.expansion,
        productUrl: `${CM}/en/Magic/Products/Singles/${a.expansionSlug}/${a.cardSlug}`, condition: a.condition, conditionLabel: a.conditionLabel,
        language: a.language, languageLabel: a.languageLabel, foil: false, extras: [], price: a.price, seller: a.seller, favoritedAt: Date.now(), unavailable: false,
      };
    };

    before(async () => {
      // A clean start: nothing synced yet, a known list here.
      await setSync(false);
      await sw.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.local.remove('cmcs.sync');
      });
      const article = (i) => ({ articleId: String(9300000000 + i), name: `Lijstkaart ${i}`, game: 'Magic', lang: 'en', expansion: 'Commander Masters',
        productUrl: `${CM}/en/Magic/Products/Singles/Commander-Masters/Card-${i}`, price: 1, wantedAmount: 1, seller: 'snowc', sellerUrl: `${CM}/en/Magic/Users/snowc`, conditionLabel: 'NM', languageLabel: 'English', extras: [] });
      await sw.evaluate(async ({ bog, fav, list }) => {
        await chrome.storage.local.set({
          'cmcs.items': { [bog.articleId]: bog },
          'cmcs.favorites': { [fav.articleId]: fav },
          'cmcs.carts': [list],
          'cmcs.job': null,
        });
      }, {
        bog: { ...favorite(BOG), amount: 2, wantedAmount: 2, status: 'in_cart', thumb: 'data:image/png;base64,AAAA', lastSeenInCartAt: Date.now(), trend: { value: 0.5, at: Date.now() } },
        fav: favorite(MAGE),
        list: { id: LIST_ID, name: 'Commander-deck', createdAt: Date.now(), game: 'Magic', items: Array.from({ length: 60 }, (_, i) => article(i)) },
      });
      await setSync(true);
    });
    after(async () => {
      await setSync(false);
      await sw.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.local.remove('cmcs.sync');
      });
      await setSync(true);
    });

    it('sends what you save to your own browser account, small and without what only this browser needs', async () => {
      const status = await merge();
      assert.equal(status.error, null);
      const all = await remote();
      assert.ok(all.s && all.s.v.delayMs === DELAY_MS, 'settings');
      assert.equal(all.s.v.cloudSync, undefined, 'whether this browser syncs stays here');
      assert.ok(all[`f.${MAGE}`], 'the favourite');
      const bog = all[`i.${BOG}`].v;
      assert.equal(bog.w, 2);
      assert.equal(bog.u, '/en/Magic/Products/Singles/Commander-2018/Bojuka-Bog', 'links without the part every record shares');
      assert.equal(JSON.stringify(bog).includes('base64'), false, 'no pictures');
      assert.equal(bog.trend, undefined, 'no prices');
      // A list too large for one sync item goes in parts.
      assert.ok(all[`l.${LIST_ID}`].n > 1 && typeof all[`l.${LIST_ID}~1`] === 'string', 'split');
      assert.ok(status.bytes > 0 && status.bytes < 100 * 1024);
    });

    it('takes what you saved in another browser, keeping what only this browser knows', async () => {
      await elsewhere({
        [`f.${NEW_FAV}`]: { u: Date.now(), v: await sw.evaluate((fav) => self.cmcs.sync.pack(fav, self.cmcs.sync.FAVORITE_FIELDS), favorite(NEW_FAV)) },
        [`i.${BOG}`]: { u: Date.now(), v: { ...(await remote())[`i.${BOG}`].v, w: 3 } },
      });
      await waitFor(async () => (await favorites())[NEW_FAV], 'the new favourite here');
      const fav = (await favorites())[NEW_FAV];
      assert.equal(fav.productUrl, `${CM}/en/Magic/Products/Singles/Commander-Masters/Sol-Ring`);
      const bog = await waitFor(async () => (await items())[BOG]?.wantedAmount === 3 && (await items())[BOG], 'the change here');
      assert.equal(bog.thumb, 'data:image/png;base64,AAAA', 'the picture stays');
      assert.equal(bog.trend.value, 0.5, 'and the trend');
    });

    it('what you remove in one browser goes in the other too', async () => {
      await sw.evaluate((id) => chrome.storage.sync.remove(`f.${id}`), NEW_FAV);
      await waitFor(async () => !(await favorites())[NEW_FAV], 'removed here');
      await sw.evaluate((id) => self.CMCS.store.removeFavorites([id]), MAGE);
      await merge();
      assert.equal((await remote())[`f.${MAGE}`], undefined, 'removed there');
    });

    it('a new browser gets everything, the large list whole', async () => {
      // A browser that never synced: nothing saved, nothing agreed yet.
      await setSync(false);
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.items': {}, 'cmcs.favorites': {}, 'cmcs.carts': [] }).then(() => chrome.storage.local.remove('cmcs.sync')));
      await setSync(true);
      await merge();
      const list = await waitFor(async () => ((await storage())['cmcs.carts'] || []).find((c) => c.id === LIST_ID), 'the list');
      assert.equal(list.items.length, 60);
      assert.equal(list.items[59].productUrl, `${CM}/en/Magic/Products/Singles/Commander-Masters/Card-59`);
      assert.equal((await items())[BOG].wantedAmount, 3);
    });

    it('settings follow you, except whether a browser syncs', async () => {
      const s = (await remote()).s.v;
      await elsewhere({ s: { u: Date.now(), v: { ...s, delayMs: 2000, notify: false } } });
      await waitFor(async () => (await storage())['cmcs.settings'].delayMs === 2000, 'taken');
      const settings = (await storage())['cmcs.settings'];
      assert.equal(settings.notify, false);
      assert.equal(settings.cloudSync, true);
      await sw.evaluate((delayMs) => chrome.storage.local.get('cmcs.settings').then(({ 'cmcs.settings': st }) => chrome.storage.local.set({ 'cmcs.settings': { ...st, delayMs, notify: true } })), DELAY_MS);
      await merge();
    });

    it('the PokemonPriceTracker key stays in the browser it was typed into', async () => {
      await sw.evaluate(() => chrome.storage.local.get('cmcs.settings').then(({ 'cmcs.settings': st }) => chrome.storage.local.set({ 'cmcs.settings': { ...st, pptApiKey: 'mine' } })));
      await merge();
      const s = (await remote()).s.v;
      assert.equal(JSON.stringify(s).includes('mine'), false, 'not in the synced copy');
      // An older version synced it: another browser's key is never taken over.
      await elsewhere({ s: { u: Date.now(), v: { ...s, pptApiKey: 'theirs', delayMs: 2100 } } });
      await waitFor(async () => (await storage())['cmcs.settings'].delayMs === 2100, 'taken');
      assert.equal((await storage())['cmcs.settings'].pptApiKey, 'mine');
      await sw.evaluate((delayMs) => chrome.storage.local.get('cmcs.settings').then(({ 'cmcs.settings': st }) => chrome.storage.local.set({ 'cmcs.settings': { ...st, delayMs, pptApiKey: '' } })), DELAY_MS);
      await merge();
    });

    it('takes only Cardmarket links from the synced copy', async () => {
      const id = '9500000001';
      await elsewhere({
        [`f.${id}`]: { u: Date.now(), v: { a: id, g: 'Magic', l: 'en', n: 'Vreemde link', u: 'javascript:alert(1)', su: 'https://evil.example/x', im: 'http://product-images.s3.cardmarket.com/x.jpg', fa: Date.now() } },
      });
      const fav = await waitFor(async () => (await favorites())[id], 'the favourite came over');
      assert.equal(fav.productUrl, null);
      assert.equal(fav.sellerUrl, null);
      assert.equal(fav.imageUrl, null);
      await sw.evaluate((id) => chrome.storage.local.get('cmcs.favorites').then(({ 'cmcs.favorites': f }) => (delete f[id], chrome.storage.local.set({ 'cmcs.favorites': f }))), id);
      await merge();
    });

    it('when the sync is full, what matters most goes first and nothing is thrown away', async () => {
      await sw.evaluate(async () => {
        const { 'cmcs.items': current } = await chrome.storage.local.get('cmcs.items');
        for (let i = 0; i < 700; i += 1) {
          const id = String(9400000000 + i);
          current[id] = { articleId: id, name: `Testkaart met een lange naam ${i}`, game: 'Magic', lang: 'en', expansion: 'Commander Masters', status: 'missing',
            productUrl: `https://www.cardmarket.com/en/Magic/Products/Singles/Commander-Masters/Testkaart-${i}`, price: 1, amount: 1, wantedAmount: 1, seller: 'Testverkoper', extras: [] };
        }
        await chrome.storage.local.set({ 'cmcs.items': current });
      });
      const status = await merge();
      assert.equal(status.error, null);
      assert.ok(status.skipped > 0, 'not everything fits');
      const all = await remote();
      assert.ok(Object.keys(all).filter((k) => !k.includes('~')).length <= 512);
      assert.ok(all[`l.${LIST_ID}`] && all.s, 'the list and the settings went first');
      assert.equal(Object.keys(await items()).length >= 701, true, 'all still here');
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
      await waitFor(async () => /nog alleen in deze browser: de sync is vol/.test(await options.locator('#syncStatus').innerText()), 'said in the settings');
      await shot(options, '29-options-sync');
      await options.close();
      await sw.evaluate(async () => {
        const { 'cmcs.items': current } = await chrome.storage.local.get('cmcs.items');
        for (const id of Object.keys(current)) if (id.startsWith('94000')) delete current[id];
        await chrome.storage.local.set({ 'cmcs.items': current });
      });
    });

    it('switched off, nothing goes anywhere', async () => {
      await setSync(false);
      const before = await remote();
      await sw.evaluate((fav) => chrome.storage.local.get('cmcs.favorites').then(({ 'cmcs.favorites': f }) => chrome.storage.local.set({ 'cmcs.favorites': { ...f, [fav.articleId]: fav } })), favorite(MAGE));
      assert.equal(await merge(), null);
      assert.deepEqual(Object.keys(await remote()).sort(), Object.keys(before).sort());
      await setSync(true);
    });
  });

  describe('what the seller wrote, and what it cost', () => {
    const COMMENT = 'Slight whitening on the back';
    const prices = {};
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      return popup;
    };
    const setPrice = (id, price) => {
      mock.article(id).price = price;
    };

    before(async () => {
      for (const id of [BOG, MAGE, SOL_KINGDOM]) prices[id] = mock.article(id).price;
      mock.article(MAGE).comment = COMMENT;
      for (const id of [BOG, MAGE, SOL_KINGDOM]) mock.state.available.set(id, mock.article(id));
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.items': {}, 'cmcs.favorites': {} }));
      mock.state.cart = new Map([[BOG, 1], [MAGE, 1]]);
    });
    after(async () => {
      for (const [id, price] of Object.entries(prices)) setPrice(id, price);
      delete mock.article(MAGE).comment;
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.favorites': {} }));
    });

    it("keeps the seller's description of the article and shows it", async () => {
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => (await items())[MAGE]?.comment === COMMENT, 'description saved');
      // Everything is in the cart: the panel only sums up, the popup lists the articles.
      const popup = await openPopup();
      const popupRow = popup.locator(`#list .cmcs-item[data-article-id="${MAGE}"]`);
      await waitFor(() => popupRow.isVisible(), 'popup row');
      assert.equal(await popupRow.locator('.cmcs-item-comment').innerText(), `“${COMMENT}”`);
      assert.match(await popupRow.locator('.cmcs-item-comment').getAttribute('title'), /Beschrijving van de verkoper: Slight whitening/);
      await popup.close();
    });

    it('notices a higher price in the cart, and keeps the price history', async () => {
      const before = (await items())[MAGE].price;
      setPrice(MAGE, Math.round((before + 0.3) * 100) / 100);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      const saved = await waitFor(async () => {
        const item = (await items())[MAGE];
        return item && Math.abs(item.price - before - 0.3) < 0.001 && item;
      }, 'new price saved');
      assert.equal(saved.priceHistory.length, 2);
      assert.equal(saved.priceHistory[0].price, before, 'the first price stays');
      assert.deepEqual([saved.priceChange.from, saved.priceChange.to], [before, saved.price]);

      await waitFor(async () => /1 artikel is duurder geworden \(\+0,30 €\)/.test(await widget(page).innerText()), 'said at the top of the panel');

      const popup = await openPopup();
      await waitFor(async () => /1 artikel is duurder geworden \(\+0,30 €\)/.test(await popup.locator('#summary').innerText()), 'and in the popup');
      const row = popup.locator(`#list .cmcs-item[data-article-id="${MAGE}"]`);
      assert.match(await row.innerText(), /0,30 € hoger/);
      await row.locator('.cmcs-item-line').click();
      const history = row.locator('.cmcs-history');
      await waitFor(() => history.isVisible(), 'price history in the opened row');
      const text = await history.innerText();
      assert.match(text, /Prijsverloop/);
      const euro = (v) => `${v.toFixed(2).replace('.', ',')} €`;
      assert.ok(text.includes(euro(saved.price)) && text.includes('+0,30 €') && text.includes(euro(before)) && /eerste prijs/.test(text), text);
      assert.ok(text.indexOf(euro(saved.price)) < text.indexOf(euro(before)), 'newest first');
      assert.equal(await history.locator('svg.cmcs-spark circle.cmcs-spark-up').count(), 1, 'the chart ends in red');
      assert.equal(await row.locator('.cmcs-item-details .cmcs-item-comment').innerText(), `“${COMMENT}”`, 'the whole description when opened');
      await shot(popup, '32-price-history');
      await popup.close();
    });

    it('picks up a new price of a saved article on an offer page', async () => {
      // Out of the cart: only an offer page can tell its price now.
      mock.state.cart = new Map([[MAGE, 1]]);
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => (await items())[BOG]?.status === 'missing', 'Bojuka Bog missing');
      setPrice(BOG, 1.49);
      await page.goto(`${CM}/en/Magic/Products/Singles/Commander-2018/Bojuka-Bog`);
      const bog = await waitFor(async () => {
        const item = (await items())[BOG];
        return item && item.price === 1.49 && item;
      }, 'price from the offer page');
      assert.deepEqual(bog.priceHistory.map((p) => p.price), [0.99, 1.49]);
      assert.deepEqual([bog.priceChange.from, bog.priceChange.to], [0.99, 1.49]);
      assert.equal(bog.status, 'missing', 'still missing: only the price changed');
    });

    it('a favourite keeps its price history too', async () => {
      await page.goto(SOL_RING_URL);
      const star = page.locator(`#articleRow${SOL_KINGDOM} cmcs-fav button`);
      await star.click();
      const was = (await waitFor(async () => (await favorites())[SOL_KINGDOM], 'favourite saved')).price;
      setPrice(SOL_KINGDOM, 1.35);
      await page.reload();
      const fav = await waitFor(async () => {
        const f = (await favorites())[SOL_KINGDOM];
        return f && f.price === 1.35 && f;
      }, 'new price of the favourite');
      assert.deepEqual(fav.priceHistory.map((p) => p.price), [was, 1.35]);
      assert.equal(fav.priceChange.to, 1.35);
    });
  });

  describe('is it still for sale? (the refresh button)', () => {
    let MINT_PRICE;
    const check = async () => (await storage())['cmcs.check'];

    before(async () => {
      MINT_PRICE = mock.article(SOL_MINT).price;
      for (const id of [MAGE, EPHEMERATE, SOL_RING, SOL_MINT]) mock.state.available.set(id, mock.article(id));
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null, 'cmcs.items': {}, 'cmcs.favorites': {}, 'cmcs.check': null }));
      // Saved from the cart (with their sellers), then the cart emptied.
      mock.state.cart = new Map([[MAGE, 1], [EPHEMERATE, 1], [SOL_RING, 1]]);
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(async () => Object.keys(await items()).length === 3, 'three saved');
      mock.state.cart = new Map();
      await patchItems({
        [MAGE]: { status: 'missing', missingReason: 'emptied' },
        [EPHEMERATE]: { status: 'missing', missingReason: 'emptied' },
        [SOL_RING]: { status: 'unavailable', lastAttempt: { at: Date.now(), ok: false, reason: 'sold', message: 'This article is no longer available.' } },
      });
      // A favourite, whose price went up since.
      const a = mock.article(SOL_MINT);
      await sw.evaluate((fav) => chrome.storage.local.set({ 'cmcs.favorites': { [fav.articleId]: fav } }), {
        articleId: SOL_MINT, productId: a.productId, game: 'Magic', lang: 'en', name: a.name, expansion: a.expansion, productUrl: SOL_RING_URL,
        sellerUrl: `${CM}/en/Magic/Users/${a.seller}`, seller: a.seller, condition: a.condition, conditionLabel: a.conditionLabel,
        language: a.language, languageLabel: a.languageLabel, foil: Boolean(a.foil), extras: a.foil ? ['Foil'] : [], price: MINT_PRICE,
        priceHistory: [{ at: Date.now() - 86400000, price: MINT_PRICE }], favoritedAt: Date.now(), unavailable: false,
      });
      // Meanwhile on Cardmarket: one sold, the sold one back, the favourite dearer.
      mock.state.available.delete(EPHEMERATE);
      mock.article(SOL_MINT).price = Math.round((MINT_PRICE + 0.4) * 100) / 100;
    });
    after(async () => {
      mock.state.available.set(EPHEMERATE, mock.article(EPHEMERATE));
      mock.article(SOL_MINT).price = MINT_PRICE;
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.favorites': {}, 'cmcs.check': null }));
    });

    it('looks every article up on Cardmarket and says what it found', async () => {
      await page.goto(`${CM}/en/Magic`);
      await waitFor(() => widget(page).isVisible(), 'reminder');
      assert.ok(await widget(page).getByRole('button', { name: 'Controleren of je artikelen nog te koop zijn' }).isVisible(), 'refresh in the panel');

      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      await waitFor(() => popup.locator('#check-now').isVisible(), 'refresh in the popup');
      await popup.locator('#check-now').click();
      const done = await waitFor(async () => {
        const c = await check();
        return c && c.state === 'done' && c;
      }, 'check finished', 30000);
      assert.deepEqual(done.counts, { checked: 4, forSale: 3, gone: 1, back: 1, up: 1, unsure: 0 });

      const all = await items();
      assert.equal(all[MAGE].status, 'missing', 'still for sale: can go back');
      assert.equal(all[MAGE].lastCheck.ok, true);
      assert.equal(all[EPHEMERATE].status, 'unavailable', 'sold');
      assert.equal(all[EPHEMERATE].lastAttempt.reason, 'sold');
      assert.equal(all[SOL_RING].status, 'missing', 'for sale again: can go back');
      assert.equal(all[SOL_RING].lastAttempt, null);
      const fav = (await favorites())[SOL_MINT];
      assert.deepEqual(fav.priceHistory.map((p) => p.price), [MINT_PRICE, mock.article(SOL_MINT).price]);
      assert.equal(fav.unavailable, false);

      const box = popup.locator('#check .cmcs-check');
      await waitFor(async () => /4 artikelen gecontroleerd\./.test(await box.innerText().catch(() => '')), 'said in the popup');
      assert.match(await box.innerText(), /3 nog te koop · 1 niet meer te koop · 1 weer te koop · 1 duurder geworden/);
      await waitFor(async () => /4 artikelen gecontroleerd/.test(await widget(page).innerText()), 'and in the panel');
      await shot(popup, '33-check-done');

      // The sold one says so, also when opened.
      const sold = popup.locator(`#list .cmcs-item[data-article-id="${EPHEMERATE}"]`);
      await sold.locator('.cmcs-item-line').click();
      assert.match(await sold.innerText(), /Gecontroleerd op .*: niet meer te vinden\./);

      await box.getByRole('button', { name: 'Sluiten' }).click();
      await waitFor(async () => (await popup.locator('#check .cmcs-check').count()) === 0, 'closed');
      assert.equal((await check()).acknowledged, true);
      await popup.close();
    });

    it('a check asked for without an open Cardmarket tab runs once one opens', async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.check': { state: 'pending', at: Date.now(), heartbeatAt: Date.now() } }));
      await page.goto(`${CM}/en/Magic`);
      const done = await waitFor(async () => {
        const c = await check();
        return c && c.state === 'done' && c;
      }, 'pending check picked up', 30000);
      assert.equal(done.counts.checked, 4);
    });

    it('while a check runs, its buttons wait; when its tab goes away, they come back', async () => {
      await patchItems({ [EPHEMERATE]: { status: 'unavailable' } });
      // A round going on in another Cardmarket tab: it holds the check's lock
      // (and has been quiet for a while: a page that takes long).
      await page.evaluate(() => {
        navigator.locks.request('cmcs.check', () => new Promise((resolve) => (window.cmcsReleaseCheck = resolve)));
      });
      await sw.evaluate(() =>
        chrome.storage.local.set({ 'cmcs.check': { state: 'running', at: Date.now() - 60000, heartbeatAt: Date.now() - 40000, total: 4, done: 1, counts: {} } }),
      );
      const refresh = widget(page).getByRole('button', { name: 'Controleren of je artikelen nog te koop zijn' });
      await waitFor(() => refresh.isDisabled(), 'the panel button waits');
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      await waitFor(() => popup.locator('#check-now').isDisabled(), 'the popup button waits');
      const link = popup.locator('#list .cmcs-link', { hasText: /^Controleren$/ });
      await waitFor(async () => (await link.count()) > 0, 'the section link');
      assert.equal(await link.first().isDisabled(), true, 'and the section link');
      await popup.close();
      await new Promise((r) => setTimeout(r, 6000));
      assert.equal((await check()).state, 'running', 'a live round is left alone');
      // That tab closes mid-round: the round ends as stopped, the buttons come back.
      await page.evaluate(() => window.cmcsReleaseCheck());
      await waitFor(async () => (await check()).state === 'cancelled', 'the lost round ends', 15000);
      assert.equal((await check()).done, 1);
      await waitFor(async () => !(await refresh.isDisabled()), 'free again');
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.check': null }));
    });

    it('Stop on a check that waits for a Cardmarket tab: it does not start', async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.check': { state: 'pending', at: Date.now(), heartbeatAt: Date.now() } }));
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 400, height: 600 });
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#tab-cart').click();
      const stop = popup.locator('#check .cmcs-check').getByRole('button', { name: 'Stoppen' });
      await waitFor(() => stop.isVisible(), 'waiting, with Stop');
      await stop.click();
      await waitFor(async () => (await check()).state === 'cancelled', 'stopped');
      await waitFor(async () => (await popup.locator('#check .cmcs-check').count()) === 0, 'nothing left to show');
      await popup.close();
      await page.goto(`${CM}/en/Magic`);
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal((await check()).state, 'cancelled', 'not started by the next Cardmarket page');
    });

    it("a waiting check skips Cloudflare's security check and runs on the page after it", async () => {
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.check': { state: 'pending', at: Date.now(), heartbeatAt: Date.now() } }));
      mock.state.challengePages = 1;
      await page.goto(`${CM}/en/Magic`);
      assert.match(await page.title(), /Just a moment/);
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal((await check()).state, 'pending', 'still waiting');
      await page.goto(`${CM}/en/Magic`);
      await waitFor(async () => (await check()).state === 'done', 'run on the real page', 30000);
    });

    it('marks an article sold only where a page plainly should show it', async () => {
      const CHEAP = '1611110005'; // BudgetCards, 1.29
      const SAME_SELLER = '1611110003'; // another Sol Ring of the same seller
      const sameSellerPrice = mock.article(SAME_SELLER).price;
      const runCheck = async () => {
        const since = Date.now();
        await sw.evaluate(async () => {
          for (const tab of await chrome.tabs.query({ url: 'https://www.cardmarket.com/*' })) {
            const reply = await chrome.tabs.sendMessage(tab.id, { type: 'cmcs.check' }).catch(() => null);
            if (reply && reply.ok) return reply;
          }
          return null;
        });
        return waitFor(async () => {
          const c = await check();
          return c && c.state === 'done' && c.finishedAt >= since && c;
        }, 'check finished', 30000);
      };
      // One saved article to look up, starred too.
      const ring = (await items())[SOL_RING];
      await sw.evaluate((ring) => chrome.storage.local.set({
        'cmcs.items': { [ring.articleId]: { ...ring, status: 'missing', lastAttempt: null, lastCheck: null } },
        'cmcs.favorites': { [ring.articleId]: { ...ring, status: undefined, unavailable: false, favoritedAt: Date.now() } },
        'cmcs.check': null,
      }), ring);
      const offersBefore = new Map(mock.state.available);
      try {
        // Gone from the first offers of a product page that has more ("Show
        // more results"): it may be further down there. Nothing changes.
        // (Earlier tests leave other Sol Rings on sale: only the ones this test needs.)
        for (const a of ARTICLES) if (a.name === 'Sol Ring') mock.state.available.delete(a.articleId);
        mock.state.available.set(SOL_KINGDOM, mock.article(SOL_KINGDOM));
        mock.state.available.set(CHEAP, mock.article(CHEAP));
        mock.state.productMore = true;
        let done = await runCheck();
        assert.equal(done.counts.unsure, 1, `unsure: ${JSON.stringify(done.counts)}`);
        assert.equal((await items())[SOL_RING].status, 'missing');
        assert.equal((await items())[SOL_RING].lastCheck.ok, null);

        // The seller has another Sol Ring, but the stock goes on on a next page: still unsure.
        mock.article(SAME_SELLER).price = 1.19;
        mock.state.available.set(SAME_SELLER, mock.article(SAME_SELLER));
        mock.state.sellerPaged = true;
        done = await runCheck();
        assert.equal(done.counts.unsure, 1, 'unsure with more pages');
        assert.equal((await items())[SOL_RING].status, 'missing');

        // The seller's whole stock of Sol Rings, without this one: sold, in both tabs.
        mock.state.sellerPaged = false;
        done = await runCheck();
        assert.equal(done.counts.gone, 1, 'sold');
        assert.equal((await items())[SOL_RING].status, 'unavailable');
        assert.equal((await items())[SOL_RING].lastAttempt.reason, 'sold');
        assert.equal((await favorites())[SOL_RING].unavailable, true, 'the favourite says so too');

        // Back on sale: it can go back, and the favourite is for sale again.
        mock.state.available.set(SOL_RING, mock.article(SOL_RING));
        done = await runCheck();
        assert.equal(done.counts.back, 1);
        assert.equal((await items())[SOL_RING].status, 'missing');
        const fav = (await favorites())[SOL_RING];
        assert.equal(fav.unavailable, false);
        assert.equal(fav.lastCheck.ok, true);

        // A product page that shows every offer like it, without this one: sold
        // (whatever the seller's page says).
        mock.state.available.delete(SOL_RING);
        mock.state.sellerPaged = true;
        mock.state.productMore = false;
        done = await runCheck();
        assert.equal(done.counts.gone, 1, 'sold: the whole list');
      } finally {
        mock.state.sellerPaged = false;
        mock.state.productMore = false;
        mock.article(SAME_SELLER).price = sameSellerPrice;
        mock.state.available.clear();
        for (const [id, a] of offersBefore) mock.state.available.set(id, a);
      }
    });
  });

  describe('Dutch or English, your choice', () => {
    let cart;
    const setLanguage = (language) =>
      sw.evaluate(async (language) => {
        const { 'cmcs.settings': settings = {} } = await chrome.storage.local.get('cmcs.settings');
        await chrome.storage.local.set({ 'cmcs.settings': { ...settings, language } });
      }, language);
    const panelSays = (re) => async () => re.test(await widget(cart).innerText().catch(() => ''));

    before(async () => {
      await setLanguage('auto');
      await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.job': null }));
      mock.state.cart = new Map([[BOG, 1]]);
      cart = await context.newPage();
      await cart.goto(`${CM}/en/Magic/ShoppingCart`);
      await waitFor(panelSays(/in je mandje/), 'Dutch panel (the browser speaks Dutch)');
    });
    after(async () => {
      await setLanguage('auto');
      await cart.close();
    });

    it('switches the popup with NL | EN in its header', async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await waitFor(() => popup.locator('#lang [data-lang="nl"][aria-pressed="true"]').isVisible(), 'NL pressed');
      assert.equal(await popup.locator('#tab-cart').innerText(), 'Winkelmandje');
      assert.equal(await popup.locator('#lang').getAttribute('aria-label'), 'Taal');

      await popup.locator('#lang').getByRole('button', { name: 'EN' }).click();
      await waitFor(async () => (await popup.locator('#tab-cart').innerText().catch(() => '')) === 'Cart', 'English popup');
      assert.equal(await popup.locator('html').getAttribute('lang'), 'en');
      assert.equal(await popup.locator('#lang [data-lang="en"]').getAttribute('aria-pressed'), 'true');
      assert.equal((await storage())['cmcs.settings'].language, 'en');
      await shot(popup, '30-popup-english');
      await popup.close();
    });

    it('the panel on Cardmarket follows at once, without a page reload', async () => {
      await cart.evaluate(() => (window.cmcsNoReload = true));
      await waitFor(panelSays(/in your cart/), 'English panel');
      assert.doesNotMatch(await widget(cart).innerText(), /mandje/);
      await setLanguage('nl');
      await waitFor(panelSays(/in je mandje/), 'Dutch again');
      assert.equal(await cart.evaluate(() => window.cmcsNoReload), true, 'same page');
    });

    it('stars, the toolbar tooltip and new pages speak it too', async () => {
      await setLanguage('en');
      const product = await context.newPage();
      await product.goto(SOL_RING_URL);
      const star = product.locator(`#articleRow${SOL_KINGDOM} cmcs-fav button`);
      await waitFor(async () => /favourite/.test((await star.getAttribute('title').catch(() => '')) || ''), 'English star');
      await setLanguage('nl');
      await waitFor(async () => /favoriet/.test((await star.getAttribute('title').catch(() => '')) || ''), 'Dutch star, same page');
      await product.close();

      await setLanguage('en');
      await patchItems({ [BOG]: { status: 'missing', missingReason: 'emptied' } });
      await waitFor(async () => /saved articles? not in your cart/.test(await sw.evaluate(() => chrome.action.getTitle({}))), 'English tooltip');
      await setLanguage('nl');
      await waitFor(async () => /niet in je mandje/.test(await sw.evaluate(() => chrome.action.getTitle({}))), 'Dutch tooltip');
      await patchItems({ [BOG]: { status: 'in_cart', missingReason: null } });
    });

    it('the settings page offers Automatic, Nederlands and English', async () => {
      await setLanguage('en');
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
      const title = () => options.locator('h2').first().innerText().catch(() => '');
      await waitFor(async () => (await title()) === 'Settings', 'English settings');
      assert.equal(await options.locator('#language [data-lang="en"]').getAttribute('aria-pressed'), 'true');

      await options.getByRole('button', { name: 'Automatic' }).click();
      await waitFor(async () => (await title()) === 'Instellingen', 'the browser language (Dutch)');
      await waitFor(async () => (await options.locator('#language [data-lang="auto"]').getAttribute('aria-pressed').catch(() => '')) === 'true', 'Automatic pressed');
      assert.equal((await storage())['cmcs.settings'].language, 'auto');

      await options.getByRole('button', { name: 'English' }).click();
      await waitFor(async () => (await title()) === 'Settings', 'English again');
      await shot(options, '31-options-english');
      await options.getByRole('button', { name: 'Nederlands' }).click();
      await waitFor(async () => (await title()) === 'Instellingen', 'Dutch');
      assert.equal((await storage())['cmcs.settings'].language, 'nl');
      await options.close();
    });
  });

  describe('a calm panel', () => {
    const FAKE = Array.from({ length: 14 }, (_, i) => String(9000000001 + i));
    const fake = (id, i) => ({
      articleId: id, game: 'Magic', lang: 'en', name: `Testkaart ${i + 1}`, price: 1, amount: 1, wantedAmount: 1,
      seller: 'Testverkoper', status: i < 12 ? 'missing' : 'unavailable', missingReason: 'emptied', extras: [],
    });
    before(async () => {
      await sw.evaluate(async (list) => {
        const { 'cmcs.items': items = {} } = await chrome.storage.local.get('cmcs.items');
        for (const item of list) items[item.articleId] = item;
        await chrome.storage.local.set({ 'cmcs.items': items, 'cmcs.job': null });
      }, FAKE.map(fake));
    });
    after(async () => {
      await sw.evaluate(async (ids) => {
        const { 'cmcs.items': items = {} } = await chrome.storage.local.get('cmcs.items');
        for (const id of ids) delete items[id];
        await chrome.storage.local.set({ 'cmcs.items': items });
      }, FAKE);
    });

    it('keeps its scroll position when something changes in the background', async () => {
      await page.goto(`${CM}/en/Magic/ShoppingCart`);
      const body = widget(page).locator('.cmcs-body');
      await waitFor(async () => (await widget(page).locator('.cmcs-item').count()) > 10, 'long list');
      await page.waitForTimeout(1500); // the page has settled (its own cart reading)
      const set = await body.evaluate((el) => ((el.scrollTop = 250), el.scrollTop));
      await patchItems({ [FAKE[0]]: { price: 1.01 } }); // the panel redraws
      await waitFor(async () => /1,01 €/.test(await widget(page).innerText()), 'redrawn');
      const now = await body.evaluate((el) => el.scrollTop);
      assert.ok(set >= 240 && now >= 240, `still where you were (${set} → ${now})`);
    });

    it('says "removed" in a strip with one undo for several, without replacing the panel', async () => {
      const panel = widget(page);
      const sold = (id) => panel.locator(`.cmcs-item[data-article-id="${id}"]`).getByRole('button', { name: 'Verwijderen uit opgeslagen lijst' });
      await sold(FAKE[12]).click();
      await waitFor(() => panel.locator('.cmcs-strip').isVisible(), 'strip');
      assert.ok(await panel.locator('.cmcs-summary').isVisible(), 'the cart view stays');
      await sold(FAKE[13]).click();
      await waitFor(async () => /2 artikelen uit de lijst gehaald/.test(await panel.locator('.cmcs-strip').innerText()), 'counted together');
      await panel.locator('.cmcs-strip').getByRole('button', { name: 'Ongedaan maken' }).click();
      await waitFor(async () => {
        const all = await items();
        return all[FAKE[12]] && all[FAKE[13]];
      }, 'both back');
    });

    it('counts copies, in the singular for one', async () => {
      // Only the first test card left to go back.
      await sw.evaluate(async (keep) => {
        const { 'cmcs.items': items } = await chrome.storage.local.get('cmcs.items');
        for (const item of Object.values(items)) if (item.articleId !== keep && item.status !== 'unavailable') item.status = 'in_cart';
        await chrome.storage.local.set({ 'cmcs.items': items });
      }, FAKE[0]);
      await waitFor(async () => /1 artikel kan terug/.test(await widget(page).innerText()), 'singular');
      await patchItems({ [FAKE[0]]: { wantedAmount: 3, amount: 3 } });
      await waitFor(async () => /3 artikelen kunnen terug/.test(await widget(page).innerText()), 'copies');
      assert.ok(await widget(page).getByRole('button', { name: /^Zet 3 terug in je mandje/ }).isVisible());
    });
  });

  it('a ZIP install has the fixed key: the same ID as the Chrome Web Store, no warning', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await waitFor(async () => /Deze installatie: ID .{4}….{4} \(ZIP-versie\)/.test(await options.locator('#syncDiag').innerText().catch(() => '')), 'diagnosis');
    assert.match(await options.locator('#syncDiag').innerText(), /ontvangen van een andere browser/);
    assert.equal(await options.locator('#syncDiag').getAttribute('title'), extensionId);
    assert.equal(extensionId, 'eghdjmloidcaeghgchegmiodkkcljkfb', 'the Store ID, also unpacked');
    assert.equal(await options.locator('#syncWarn').isVisible(), false, 'no warning about the ID');
    await options.close();
  });

  it('options page shows the saved data and stores settings', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await waitFor(async () => /opgeslagen: \d+ in je mandje, \d+ deels, \d+ ontbreken/.test(await options.locator('#dataSummary').innerText()), 'data summary');
    // Every article is counted once: the parts add up to the total.
    const [total, ...parts] = (await options.locator('#dataSummary').innerText()).match(/\d+/g).slice(0, 6).map(Number);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    await options.fill('#delay', '2.5');
    await options.locator('#delay').dispatchEvent('change');
    await waitFor(async () => (await storage())['cmcs.settings'].delayMs === 2500, 'delay saved');
    await shot(options, '06-options');
    await sw.evaluate((delayMs) => chrome.storage.local.set({ 'cmcs.settings': { delayMs } }), DELAY_MS);
    await options.close();
  });

  it('leaves the saved list alone when logged out', async () => {
    mock.state.loggedIn = false;
    mock.state.cart.clear();
    await patchItems({ [SOL_RING]: { status: 'in_cart' } });
    await sw.evaluate(() => chrome.storage.local.set({ 'cmcs.meta': {}, 'cmcs.job': null }));

    await page.goto(`${CM}/en/Magic`);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await items())[SOL_RING].status, 'in_cart');
    mock.state.loggedIn = true;
  });

  // Last: it wipes everything.
  it('"Delete everything" leaves nothing behind, here or in the sync', async () => {
    await sw.evaluate(async () => {
      const { 'cmcs.settings': settings } = await chrome.storage.local.get('cmcs.settings');
      await chrome.storage.local.set({
        'cmcs.settings': { ...settings, pptApiKey: 'secret', notify: false, language: 'nl', cloudSync: true },
        'cmcs.meta': { account: 'someone' },
      });
      await chrome.storage.sync.set({ s: { u: Date.now(), v: { notify: false } } });
    });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await waitFor(() => options.locator('#clear').isVisible(), 'settings page');
    options.once('dialog', (dialog) => dialog.accept());
    await options.locator('#clear').click();
    await waitFor(async () => (await options.locator('#dataMessage').innerText()) === 'Alles is gewist.', 'said so');
    const left = await storage();
    assert.deepEqual(Object.keys(left).filter((key) => key.startsWith('cmcs.')), ['cmcs.settings']);
    assert.deepEqual(left['cmcs.settings'], { language: 'nl', cloudSync: true }, 'settings start over, except language and sync');
    assert.equal(await options.locator('#notify').isChecked(), true, 'the form shows the defaults');
    const synced = await sw.evaluate(() => chrome.storage.sync.get(null));
    assert.deepEqual(Object.keys(synced).filter((key) => key !== 's' && key !== '_e'), [], 'nothing left in the sync');
    assert.equal(synced._e.cleared, true, 'a new copy, marked as wiped on purpose');
    await options.close();
  });
});
