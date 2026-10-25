/*
 * Sync between two browsers, without a browser: the real store.js and
 * sync.js run twice, each in its own context with its own local storage,
 * sharing one synced copy (like two computers on one Google account).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = ['src/shared/store.js', 'src/background/sync.js'].map((file) => [file, fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')]);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** A chrome.storage area on a Map. */
function area(map) {
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries([...map].map(([key, value]) => [key, clone(value)]));
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const key of list) if (map.has(key)) out[key] = clone(map.get(key));
      return out;
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) map.set(key, clone(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

/** One browser with Cart Saver, on the given synced copy (a Map). */
function browser(synced) {
  const local = new Map([['cmcs.settings', { cloudSync: true }]]);
  const chrome = {
    storage: { local: area(local), sync: area(synced), session: area(new Map()), onChanged: { addListener() {} } },
    runtime: { id: 'test', getManifest: () => ({}) },
    i18n: { getMessage: () => '', getUILanguage: () => 'en' },
    permissions: { contains: async () => false },
  };
  const context = vm.createContext({ chrome, console, URL, crypto: globalThis.crypto, setTimeout, clearTimeout, navigator: {} });
  for (const [file, source] of code) vm.runInContext(source, context, { filename: file });
  const { store, sync } = context.CMCS;
  return {
    store,
    local,
    useCopy(map) {
      chrome.storage.sync = area(map);
    },
    merge: () => sync.merge(),
    favorites: async () => Object.keys(await store.getFavorites()).sort(),
    lists: async () => (await store.getCarts()).map((cart) => cart.id).sort(),
    items: async () => Object.keys(await store.getItems()).sort(),
    async star(id, extra = {}) {
      await store.updateFavorites((favorites) => ({ ...favorites, [id]: { articleId: id, name: `Card ${id}`, game: 'Magic', lang: 'en', price: 1, favoritedAt: 1, ...extra } }));
    },
    async unstar(id) {
      await store.updateFavorites((favorites) => {
        const next = { ...favorites };
        delete next[id];
        return next;
      });
    },
    async saveList(id, items = []) {
      await store.updateCarts((carts) => [...carts, { id, name: `List ${id}`, game: 'Magic', createdAt: 1, items }]);
    },
    async save(id) {
      await store.updateItems((items) => ({ ...items, [id]: { articleId: id, name: `Card ${id}`, game: 'Magic', lang: 'en', status: 'missing', amount: 1, wantedAmount: 1 } }));
    },
  };
}

/** What Chrome counts for one stored item: key and JSON in UTF-8, "<" written as \u003C. */
const chromeBytes = (key, value) =>
  Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value).replace(/</g, '\\u003C').replace(/[\u2028\u2029\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));

describe('two browsers on one account', () => {
  it('what you save, change or remove in one goes to the other', async () => {
    const copy = new Map();
    const a = browser(copy);
    const b = browser(copy);
    await a.star('1');
    await a.saveList('deck');
    await a.merge();
    await b.merge();
    assert.deepEqual(await b.favorites(), ['1']);
    assert.deepEqual(await b.lists(), ['deck']);

    await b.unstar('1');
    await b.merge();
    await a.merge();
    assert.deepEqual(await a.favorites(), [], 'removed in the other browser too');
    assert.deepEqual(await a.lists(), ['deck']);
  });

  it('a copy that Chrome replaced is joined, not followed: nothing of this browser is lost', async () => {
    // The laptop synced only with itself (Chrome sync or "Extensions" off)…
    const laptopOnly = new Map();
    const laptop = browser(laptopOnly);
    await laptop.star('10');
    await laptop.saveList('laptop-list');
    await laptop.save('20');
    await laptop.merge();
    // …while the desktop has the account's copy.
    const account = new Map();
    const desktop = browser(account);
    await desktop.star('11');
    await desktop.merge();
    // Extensions sync switched on: Chrome replaces the laptop's copy with the account's.
    laptop.useCopy(account);
    await laptop.merge();
    assert.deepEqual(await laptop.favorites(), ['10', '11'], 'its own favourite stays, the other one comes');
    assert.deepEqual(await laptop.lists(), ['laptop-list']);
    assert.deepEqual(await laptop.items(), ['20']);
    await desktop.merge();
    assert.deepEqual(await desktop.favorites(), ['10', '11'], 'and goes to the desktop');
    assert.deepEqual(await desktop.lists(), ['laptop-list']);
    // After that, removing works again as usual.
    await desktop.unstar('10');
    await desktop.merge();
    await laptop.merge();
    assert.deepEqual(await laptop.favorites(), ['11']);
  });

  it('an emptied copy (the extension removed in another browser) deletes nothing', async () => {
    const copy = new Map();
    const a = browser(copy);
    const b = browser(copy);
    await a.star('1');
    await a.saveList('deck');
    await a.merge();
    await b.merge();
    copy.clear();
    await b.merge();
    assert.deepEqual(await b.favorites(), ['1']);
    assert.deepEqual(await b.lists(), ['deck']);
    assert.ok(copy.has('f.1') && copy.has('l.deck'), 'put back in the copy');
    await a.merge();
    assert.deepEqual(await a.favorites(), ['1'], 'still there in the first browser');
  });

  it('"Delete everything" in one browser does empty the others that synced with it', async () => {
    const copy = new Map();
    const a = browser(copy);
    const b = browser(copy);
    await a.star('1');
    await a.saveList('deck');
    await a.merge();
    await b.merge();
    // A browser that never met this copy before (its own memory is of another one).
    const elsewhere = new Map();
    const c = browser(elsewhere);
    await c.star('9');
    await c.merge();
    // What the settings page does.
    const old = copy.get('_e');
    copy.clear();
    copy.set('_e', { id: 'wiped', at: Date.now(), cleared: true, prev: [old.id] });
    for (const key of [...a.local.keys()]) if (key !== 'cmcs.settings') a.local.delete(key);
    await b.merge();
    assert.deepEqual(await b.favorites(), [], 'emptied');
    assert.deepEqual(await b.lists(), []);
    c.useCopy(copy);
    await c.merge();
    assert.deepEqual(await c.favorites(), ['9'], 'one that never synced with it keeps its own');
  });

  it('a while without sync, then Chrome brings the account copy back: what you did meanwhile stays', async () => {
    const account = new Map();
    const laptop = browser(account);
    const desktop = browser(account);
    await laptop.star('1');
    await laptop.merge();
    await desktop.merge();
    // Sync off on the laptop: storage.sync goes on locally, from where it was.
    const offline = new Map([...account].map(([k, v]) => [k, clone(v)]));
    laptop.useCopy(offline);
    await laptop.star('50');
    await laptop.saveList('trip');
    await laptop.merge();
    await desktop.star('60');
    await desktop.merge();
    // Sync on again: Chrome puts the account's copy (same id) in place of the local one.
    laptop.useCopy(account);
    await laptop.merge();
    assert.deepEqual(await laptop.favorites(), ['1', '50', '60'], 'nothing of the laptop lost');
    assert.deepEqual(await laptop.lists(), ['trip']);
    await desktop.merge();
    assert.deepEqual(await desktop.favorites(), ['1', '50', '60']);
    assert.deepEqual(await desktop.lists(), ['trip']);
    // And removing works again right after.
    await desktop.unstar('50');
    await desktop.merge();
    await laptop.merge();
    assert.deepEqual(await laptop.favorites(), ['1', '60']);
  });

  it('a while without sync and without changes: what was removed elsewhere meanwhile goes here too', async () => {
    const account = new Map();
    const laptop = browser(account);
    const desktop = browser(account);
    await laptop.star('1');
    await laptop.star('2');
    await laptop.merge();
    await desktop.merge();
    laptop.useCopy(new Map([...account].map(([k, v]) => [k, clone(v)])));
    await laptop.merge();
    await desktop.unstar('2');
    await desktop.merge();
    laptop.useCopy(account);
    await laptop.merge();
    assert.deepEqual(await laptop.favorites(), ['1']);
  });

  it('marks of browsers that stopped writing long ago are cleared away', async () => {
    const copy = new Map();
    const a = browser(copy);
    copy.set('_w.old-browser', { n: 'x', at: Date.now() - 400 * 24 * 60 * 60 * 1000 });
    copy.set('_w.recent-browser', { n: 'y', at: Date.now() - 24 * 60 * 60 * 1000 });
    await a.star('1');
    const status = await a.merge();
    assert.equal(copy.has('_w.old-browser'), false);
    assert.equal(copy.has('_w.recent-browser'), true);
    assert.equal([...copy.keys()].filter((k) => k.startsWith('_w.')).length, 2, "this browser's own mark and the recent one");
    assert.equal(status.removed, 0, 'not counted as removed records');
    // A round with nothing new writes nothing at all.
    const before = JSON.stringify([...copy]);
    await a.merge();
    assert.equal(JSON.stringify([...copy]), before);
  });

  it('a copy of this profile elsewhere (a restored backup) settles: no endless writing, removals stick', async () => {
    const copy = new Map();
    const a = browser(copy);
    await a.star('1');
    await a.star('2');
    await a.star('3');
    await a.merge();
    // The profile folder copied to another computer: the same local data, the same name.
    const b = browser(copy);
    for (const [k, v] of a.local) b.local.set(k, clone(v));
    await a.unstar('2');
    let writes = 0;
    for (let i = 0; i < 8; i += 1) {
      const before = JSON.stringify([...copy]);
      await (i % 2 ? a : b).merge();
      if (JSON.stringify([...copy]) !== before) writes += 1;
    }
    assert.ok(writes <= 3, `settles (${writes} writes in 8 rounds)`);
    // From then on, removing works in both.
    await b.unstar('3');
    await b.merge();
    await a.merge();
    assert.equal((await a.favorites()).includes('3'), false);
    assert.equal((await b.favorites()).includes('3'), false);
  });

  it('"Delete everything" while a laptop had sync off keeps what the laptop saved after it', async () => {
    const account = new Map();
    const laptop = browser(account);
    const desktop = browser(account);
    await laptop.star('1');
    await laptop.merge();
    await desktop.merge();
    const offline = new Map([...account].map(([k, v]) => [k, clone(v)]));
    laptop.useCopy(offline);
    // The desktop wipes everything (what the settings page does)…
    const old = account.get('_e');
    account.clear();
    account.set('_e', { id: 'wiped', at: Date.now() - 1000, cleared: true, prev: [old.id] });
    // …and later the laptop, sync still off, saves new things.
    await laptop.star('50');
    await laptop.merge();
    laptop.useCopy(account);
    await laptop.merge();
    assert.ok((await laptop.favorites()).includes('50'), 'saved after the wipe: kept');
  });

  it('a browser that only takes changes renews its mark now and then, so it is never taken for gone', async () => {
    const copy = new Map();
    const reader = browser(copy);
    const writer = browser(copy);
    await writer.star('1');
    await writer.merge();
    await reader.merge();
    const key = [...copy.keys()].find((k) => k.startsWith('_w.') && k !== `_w.${writer.local.get('cmcs.sync').id}`);
    copy.set(key, { ...copy.get(key), at: Date.now() - 40 * 24 * 60 * 60 * 1000 });
    await reader.merge();
    assert.ok(copy.get(key).at > Date.now() - 60000, 'renewed');
    await writer.unstar('1');
    await writer.merge();
    await reader.merge();
    assert.deepEqual(await reader.favorites(), []);
  });

  it('after an update from a version without the copy id, nothing is removed by mistake', async () => {
    const copy = new Map();
    const a = browser(copy);
    await a.star('1');
    await a.star('2');
    await a.merge();
    // As 1.6.8 left it: no id in the copy or in this browser's memory, and a
    // record this browser agreed on is not in the copy (Chrome replaced it).
    copy.delete('_e');
    copy.delete('f.2');
    const state = a.local.get('cmcs.sync');
    delete state.epoch;
    await a.merge();
    assert.deepEqual(await a.favorites(), ['1', '2']);
    assert.ok(copy.has('f.2') && copy.has('_e'));
  });

  it('settings follow you; the API key and the sync switch stay in their browser', async () => {
    const copy = new Map();
    const a = browser(copy);
    const b = browser(copy);
    a.local.set('cmcs.settings', { cloudSync: true, delayMs: 1500, pptApiKey: 'secret' });
    await a.merge();
    await b.merge();
    assert.equal(JSON.stringify(copy.get('s')).includes('secret'), false, 'not in the copy');
    const theirs = b.local.get('cmcs.settings');
    assert.equal(theirs.delayMs, 1500);
    assert.equal(theirs.pptApiKey, undefined);
    assert.equal(theirs.cloudSync, true);
  });
});

describe('what Chrome counts', () => {
  it('every stored item stays under 8,192 bytes, also with Japanese names, "<" and emoji', async () => {
    const copy = new Map();
    const a = browser(copy);
    const b = browser(copy);
    const items = Array.from({ length: 60 }, (_, i) => ({
      articleId: String(9300000000 + i),
      name: `ピカチュウ ex ${i} <SAR> 🎴`,
      game: 'Pokemon',
      lang: 'ja',
      expansion: 'テラスタルフェスex',
      productUrl: `https://www.cardmarket.com/ja/Pokemon/Products/Singles/Terastal-Festival/Pikachu-ex-${i}`,
      price: 12.5,
      wantedAmount: 1,
      seller: 'カードショップ',
      comment: '美品です <NM> 🙂',
      extras: [],
    }));
    await a.saveList('jp', items);
    const status = await a.merge();
    assert.equal(status.error, null);
    assert.ok(copy.has('l.jp~1'), 'split in parts');
    let total = 0;
    for (const [key, value] of copy) {
      const bytes = chromeBytes(key, value);
      total += bytes;
      assert.ok(bytes <= 8192, `${key}: ${bytes} bytes`);
    }
    assert.ok(Math.abs(total - status.bytes) <= 64, `counted ${status.bytes}, Chrome counts ${total}`);
    await b.merge();
    const list = (await b.store.getCarts()).find((cart) => cart.id === 'jp');
    assert.equal(list.items.length, 60);
    assert.equal(list.items[59].name, 'ピカチュウ ex 59 <SAR> 🎴', 'whole again, emoji included');
    assert.equal(list.items[59].comment, '美品です <NM> 🙂');
  });
});
