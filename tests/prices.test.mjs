/*
 * Prices without a browser: reading an amount in every notation Cardmarket
 * (or a layout change) may use, and the price history kept per article.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let cm;
let store;

before(async () => {
  globalThis.chrome = { storage: { local: {}, onChanged: { addListener() {} } }, i18n: { getMessage: () => '' } };
  await import('../src/content/cardmarket.js');
  await import('../src/shared/store.js');
  ({ cm, store } = globalThis.CMCS);
});

describe('reading a price', () => {
  it('understands every notation', () => {
    const cases = {
      '0.99': 0.99,
      '0,99 €': 0.99,
      '1.234,56 €': 1234.56,
      '€1,234.56': 1234.56,
      '1 234,56 €': 1234.56,
      ' 1 234,50 €': 1234.5,
      '12,5': 12.5,
      '1.000,00 €': 1000,
      '2x 0,99 € 1,98 €': 0.99,
      '134,99 €': 134.99,
      3: 3,
    };
    for (const [text, value] of Object.entries(cases)) assert.equal(cm.parseMoney(text), value, text);
  });

  it('says so when there is none', () => {
    for (const text of ['', null, undefined, 'abc', '€']) assert.equal(cm.parseMoney(text), null, String(text));
  });
});

describe('price history', () => {
  it('starts with the price an article was saved with', () => {
    assert.deepEqual(store.priceHistoryOf({ price: 0.2, firstSavedAt: 5 }), [{ at: 5, price: 0.2 }]);
    assert.deepEqual(store.priceHistoryOf({}), []);
  });

  it('adds a new price, flags the change, and ignores the same price', () => {
    const saved = { articleId: '1', price: 0.2, firstSavedAt: 1 };
    assert.equal(store.notePrice(saved, 0.2, 2), saved, 'same price: nothing changes');
    assert.equal(store.notePrice(saved, 0.2001, 2), saved, 'rounding is no change');
    const up = store.notePrice(saved, 0.25, 10);
    assert.deepEqual(up.priceHistory, [{ at: 1, price: 0.2 }, { at: 10, price: 0.25 }]);
    assert.deepEqual(up.priceChange, { from: 0.2, to: 0.25, at: 10 });
    const down = store.notePrice(up, 0.22, 20);
    assert.deepEqual(down.priceHistory.map((p) => p.price), [0.2, 0.25, 0.22]);
    assert.deepEqual(down.priceChange, { from: 0.25, to: 0.22, at: 20 });
  });

  it('ignores prices that are not prices', () => {
    const saved = { articleId: '1', price: 0.2 };
    for (const price of [null, undefined, NaN, 0, -1]) assert.equal(store.notePrice(saved, price, 5), saved, String(price));
  });

  it('keeps the first price and the latest ones', () => {
    let item = { articleId: '1', price: 1, firstSavedAt: 0 };
    for (let i = 1; i <= 50; i += 1) item = store.notePrice(item, 1 + i / 100, i);
    assert.equal(item.priceHistory.length, store.PRICE_HISTORY_MAX);
    assert.equal(item.priceHistory[0].price, 1, 'the first price stays');
    assert.equal(item.priceHistory.at(-1).price, 1.5);
  });

  it('a cart reading notes a new price and says which articles changed', () => {
    const items = { 1: { articleId: '1', price: 0.2, status: 'in_cart', amount: 1, firstSavedAt: 1 } };
    const first = store.applyCartSnapshot(items, [{ articleId: '1', price: 0.3, amount: 1 }], { now: 50, addNew: true, markMissing: true });
    assert.deepEqual(first.priceChanged, ['1']);
    assert.deepEqual(first.items['1'].priceHistory.map((p) => p.price), [0.2, 0.3]);
    const again = store.applyCartSnapshot(first.items, [{ articleId: '1', price: 0.3, amount: 1 }], { now: 60, addNew: true, markMissing: true });
    assert.deepEqual(again.priceChanged, [], 'the same price again is no change');
    const fresh = store.applyCartSnapshot({}, [{ articleId: '9', price: 0.5, amount: 1 }], { now: 70, addNew: true });
    assert.deepEqual(fresh.items['9'].priceHistory, [{ at: 70, price: 0.5 }]);
    assert.equal(fresh.items['9'].priceChange, null, 'a new article has no change yet');
  });

  it('a favourite starts with its price', () => {
    const fav = store.toFavorite({ articleId: '3', price: 1.1, name: 'Sol Ring' }, 100);
    assert.deepEqual(fav.priceHistory, [{ at: 100, price: 1.1 }]);
  });

  it('a saved list keeps what an article is, not its price story', () => {
    const [copy] = store.savedCopies([{ articleId: '1', price: 1, priceHistory: [{ at: 1, price: 1 }], priceChange: { from: 0.9, to: 1, at: 1 } }]);
    assert.equal(copy.priceHistory, undefined);
    assert.equal(copy.priceChange, undefined);
  });
});
