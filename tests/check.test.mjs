/*
 * "Is it still for sale?" without a browser: the real store.js and check.js,
 * with stand-in Cardmarket pages, for what counts as proof that an article
 * was sold (and what does not).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const STORE = read('src/shared/store.js');
const CHECK = read('src/content/check.js');
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const ID = '1001';
const SELLER = 'https://www.cardmarket.com/en/Magic/Users/Seller/Offers/Singles?name=Sol+Ring';
const PRODUCT = 'https://www.cardmarket.com/en/Magic/Products/Singles/C21/Sol-Ring?language=1&minCondition=2';
const article = (extra = {}) => ({
  articleId: ID, name: 'Sol Ring', game: 'Magic', lang: 'en', status: 'missing', price: 1.49,
  sellerUrl: 'https://www.cardmarket.com/en/Magic/Users/Seller', productUrl: 'https://www.cardmarket.com/en/Magic/Products/Singles/C21/Sol-Ring',
  ...extra,
});
const offer = (id, price = 1, name = 'Sol Ring') => ({ articleId: String(id), name, price });
const rows = (n, from = 5000, price = 1) => Array.from({ length: n }, (_, i) => offer(from + i, price));

/** A parsed page: offer rows, the selectors it has, and where it ended up. */
function page({ rows: list = [], has = [], url }) {
  return {
    url,
    doc: {
      querySelectorAll: () => list.map((o) => ({ offer: o })),
      querySelector: (selector) => (selector.split(',').some((s) => has.includes(s.trim())) ? {} : null),
    },
  };
}

/** One tab with Cart Saver: its storage, and Cardmarket answering with `pages`. */
function tab({ items = {}, favorites = {}, check = null, pages = {}, locks, hold } = {}) {
  const local = new Map([
    ['cmcs.settings', { delayMs: 0 }],
    ['cmcs.items', items],
    ['cmcs.favorites', favorites],
    ['cmcs.check', check],
  ]);
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = keys == null ? [...local.keys()] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, clone(local.get(k))]));
        },
        async set(entries) {
          for (const [k, v] of Object.entries(entries)) local.set(k, clone(v));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) local.delete(k);
        },
      },
      onChanged: { addListener() {} },
    },
    i18n: { getMessage: () => '' },
    permissions: { contains: async () => false },
  };
  const requests = [];
  const cm = {
    OFFER_ROWS: '.article-row',
    sellerSearchUrl: (a) => (a.sellerUrl ? SELLER : null),
    alternativesUrl: (a) => (a.productUrl ? PRODUCT : null),
    parseOfferRow: (row) => row.offer,
    isChallenge: () => false,
    async fetchDocument(url) {
      requests.push(url);
      if (hold) await hold;
      const which = url === SELLER ? pages.seller : pages.product;
      if (!which) throw Object.assign(new Error('HTTP 500'), { kind: 'http_error' });
      if (which.error) throw Object.assign(new Error(which.error), { kind: which.error });
      return page({ url, ...which });
    },
  };
  const context = vm.createContext({
    chrome, console, URL, setTimeout, clearTimeout,
    navigator: locks ? { locks } : {},
    document: { visibilityState: 'visible', documentElement: { outerHTML: '<html></html>' }, addEventListener() {} },
  });
  vm.runInContext(STORE, context, { filename: 'store.js' });
  context.CMCS.cm = cm;
  context.CMCS.t = (key) => key;
  vm.runInContext(CHECK, context, { filename: 'check.js' });
  const { store, check: checker } = context.CMCS;
  return {
    local, requests, store, checker,
    item: () => local.get('cmcs.items')[ID],
    fav: () => local.get('cmcs.favorites')[ID],
    async run() {
      const reply = await checker.start();
      assert.equal(reply.ok, true, JSON.stringify(reply));
      for (let i = 0; i < 200; i += 1) {
        const c = local.get('cmcs.check');
        if (c && c.finishedAt && c.state !== 'running') return c;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('the check did not finish');
    },
  };
}

const SELLER_PAGE = ['#UserOffersTable'];
const PRODUCT_PAGE = ['.article-table', '.table-body'];
const LOAD_MORE = [...PRODUCT_PAGE, '#loadMore'];

describe('what proves an article was sold', () => {
  it("the seller's whole stock of that name, without it: sold", async () => {
    const t = tab({
      items: { [ID]: article() },
      pages: { seller: { url: SELLER, rows: [offer(2, 1.19)], has: SELLER_PAGE }, product: { url: PRODUCT, rows: rows(50, 5000, 1), has: LOAD_MORE } },
    });
    const done = await t.run();
    assert.deepEqual(done.counts, { checked: 1, forSale: 0, gone: 1, back: 0, up: 0, unsure: 0 });
    assert.equal(t.item().status, 'unavailable');
    assert.equal(t.item().lastAttempt.reason, 'sold');
  });

  it('a product page that lists every offer like it, without it: sold', async () => {
    const t = tab({ items: { [ID]: article() }, pages: { seller: { url: SELLER, rows: [], has: SELLER_PAGE }, product: { url: PRODUCT, rows: rows(3, 5000, 0.5), has: PRODUCT_PAGE } } });
    assert.equal((await t.run()).counts.gone, 1);
  });

  it('no offers like it at all on the product page: sold', async () => {
    const t = tab({ items: { [ID]: article() }, pages: { product: { url: PRODUCT, rows: [], has: PRODUCT_PAGE } } });
    assert.equal((await t.run()).counts.gone, 1);
  });
});

describe('what does not', () => {
  const unsure = async (pages, extra = {}) => {
    const t = tab({ items: { [ID]: article(extra) }, pages });
    const done = await t.run();
    assert.equal(done.counts.unsure, 1, JSON.stringify(done.counts));
    assert.equal(t.item().status, 'missing', 'nothing changes');
    assert.equal(t.item().lastCheck.ok, null);
  };

  it('the first 50 offers of more (a tie at the last price, a price that went up since)', async () => {
    await unsure({ product: { url: PRODUCT, rows: rows(50, 5000, 1.49), has: LOAD_MORE } });
    await unsure({ product: { url: PRODUCT, rows: rows(50, 5000, 2.5), has: LOAD_MORE } }, { price: 1 });
    await unsure({ product: { url: PRODUCT, rows: rows(50, 5000, 2.5), has: PRODUCT_PAGE } }, { price: null });
  });

  it('a "Show more results" button, even under 50 rows', async () => {
    await unsure({ product: { url: PRODUCT, rows: rows(12), has: LOAD_MORE } });
  });

  it("a seller's stock that goes on on another page, or where the search did not take", async () => {
    const product = { url: PRODUCT, rows: rows(50), has: LOAD_MORE };
    await unsure({ seller: { url: SELLER, rows: [offer(2)], has: [...SELLER_PAGE, '.pagination'] }, product });
    await unsure({ seller: { url: SELLER, rows: rows(20), has: SELLER_PAGE }, product });
    await unsure({ seller: { url: SELLER, rows: [offer(2, 1, 'Island')], has: SELLER_PAGE }, product });
    await unsure({ seller: { url: SELLER, rows: [], has: SELLER_PAGE }, product });
  });

  it('a page that sent you elsewhere, or did not load', async () => {
    await unsure({ seller: { url: 'https://www.cardmarket.com/en/Magic/Users/Seller', rows: [offer(2)], has: SELLER_PAGE }, product: { url: PRODUCT, rows: rows(50), has: LOAD_MORE } });
    await unsure({ product: { url: 'https://www.cardmarket.com/en/Magic', rows: [], has: [] } });
    await unsure({ seller: { url: SELLER, rows: [offer(2)], has: [...SELLER_PAGE, '.pagination'] } });
  });

  it('a Cloudflare check stops the round instead', async () => {
    const t = tab({ items: { [ID]: article() }, pages: { seller: { error: 'challenge' } } });
    const done = await t.run();
    assert.equal(done.state, 'error');
    assert.equal(done.error, 'challenge');
    assert.equal(t.item().status, 'missing');
  });
});

describe('found again', () => {
  it('a sold article that is back can go back; the same article starred says so too', async () => {
    const sold = article({ status: 'unavailable', lastAttempt: { reason: 'sold' } });
    const t = tab({
      items: { [ID]: sold },
      favorites: { [ID]: { ...article(), status: undefined, unavailable: true, unavailableMessage: 'sold', priceHistory: [{ at: 1, price: 1.49 }] } },
      pages: { product: { url: PRODUCT, rows: [offer(ID, 1.79)], has: PRODUCT_PAGE } },
    });
    const done = await t.run();
    assert.deepEqual(done.counts, { checked: 1, forSale: 1, gone: 0, back: 1, up: 1, unsure: 0 });
    assert.equal(t.item().status, 'missing');
    assert.equal(t.fav().unavailable, false);
    assert.equal(t.fav().lastCheck.ok, true);
    assert.deepEqual(t.fav().priceHistory.map((p) => p.price), [1.49, 1.79], "the favourite's own history");
  });

  it('a saved article found sold marks its favourite sold as well', async () => {
    const t = tab({
      items: { [ID]: article() },
      favorites: { [ID]: { ...article(), status: undefined, unavailable: false } },
      pages: { product: { url: PRODUCT, rows: [], has: PRODUCT_PAGE } },
    });
    await t.run();
    assert.equal(t.fav().unavailable, true);
    assert.equal(t.fav().lastCheck.ok, false);
  });
});

describe('which articles a round looks at', () => {
  const { store } = tab();
  const at = (n) => ({ lastCheck: { at: n } });

  it('saved articles and favourites together, the longest unchecked first', () => {
    const items = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`i${i}`, { articleId: `i${i}`, status: 'missing', ...at(100 + i) }]));
    const favorites = { f1: { articleId: 'f1', ...at(50) }, f2: { articleId: 'f2' } };
    const targets = clone(store.checkTargets(items, favorites, 30));
    assert.equal(targets.length, 30);
    assert.deepEqual(targets.slice(0, 3).map((t) => t.article.articleId), ['f2', 'f1', 'i0'], 'favourites get their turn too');
  });

  it('a favourite whose saved article is ignored is looked up; one in the cart is not', () => {
    const items = { a: { articleId: 'a', status: 'ignored' }, b: { articleId: 'b', status: 'in_cart' }, c: { articleId: 'c', status: 'missing' } };
    const favorites = { a: { articleId: 'a' }, b: { articleId: 'b' }, c: { articleId: 'c' } };
    const targets = clone(store.checkTargets(items, favorites)).map((t) => `${t.kind}:${t.article.articleId}`).sort();
    assert.deepEqual(targets, ['favorite:a', 'item:c']);
  });
});

describe('starting and stopping', () => {
  it('Stop on a check that waits for a Cardmarket tab: it never starts', async () => {
    const t = tab({ items: { [ID]: article() }, check: { state: 'pending', at: Date.now(), heartbeatAt: Date.now() }, pages: { product: { url: PRODUCT, rows: [], has: PRODUCT_PAGE } } });
    await t.store.cancelCheck();
    assert.equal(t.local.get('cmcs.check').state, 'cancelled');
    assert.equal(t.local.get('cmcs.check').acknowledged, true, 'nothing to show for it');
    await t.checker.resumePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.requests.length, 0, 'no page asked for');
    assert.equal(t.item().status, 'missing');
  });

  it('a second start while checking says so (not the refill message)', async () => {
    const t = tab({ items: { [ID]: article() }, check: { state: 'running', at: Date.now(), heartbeatAt: Date.now() } });
    assert.deepEqual({ ...(await t.checker.start()) }, { ok: false, error: 'checking' });
  });

  it('a round whose tab went away ends as stopped; a live one is left alone', async () => {
    const quiet = { state: 'running', at: Date.now() - 60000, heartbeatAt: Date.now() - 40000, total: 30, done: 4 };
    const noLock = { query: async () => ({ held: [] }), request: () => {} };
    const gone = tab({ check: quiet, locks: noLock });
    assert.equal(await gone.checker.reapDead(), true);
    assert.equal(gone.local.get('cmcs.check').state, 'cancelled');
    assert.equal(gone.local.get('cmcs.check').done, 4);
    const live = tab({ check: quiet, locks: { query: async () => ({ held: [{ name: 'cmcs.check' }] }), request: () => {} } });
    assert.equal(await live.checker.reapDead(), false, 'its lock is held');
    assert.equal(live.local.get('cmcs.check').state, 'running');
    const busy = tab({ check: { ...quiet, heartbeatAt: Date.now() - 3000 }, locks: noLock });
    assert.equal(await busy.checker.reapDead(), false, 'it wrote a moment ago');
    // An incognito tab cannot see the other side's locks: it does not judge.
    const otherSide = tab({ check: { ...quiet, incognito: true }, locks: noLock });
    assert.equal(await otherSide.checker.reapDead(), false);
  });

  it('a round whose record another round took over stops and leaves it alone', async () => {
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    const items = Object.fromEntries(['1', '2', '3'].map((id) => [id, { ...article(), articleId: id, sellerUrl: null }]));
    const t = tab({ items, hold, pages: { product: { url: PRODUCT, rows: [], has: PRODUCT_PAGE } } });
    await t.checker.start();
    // The first page is on its way; meanwhile a round in another tab (the
    // other side of incognito, say) starts and writes its own record.
    for (let i = 0; i < 200 && !t.requests.length; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.requests.length, 1);
    const theirs = { state: 'running', at: Date.now() + 1, heartbeatAt: Date.now(), total: 9, done: 0, counts: {} };
    t.local.set('cmcs.check', theirs);
    release();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(clone(t.local.get('cmcs.check')), theirs, 'not written over');
    assert.equal(t.requests.length, 1, 'no next article');
    assert.equal(t.checker.isRunning(), false);
  });
});
