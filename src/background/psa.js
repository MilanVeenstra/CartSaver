/*
 * Estimated PSA values for Pokémon cards (optional, off by default).
 *
 * Cardmarket has no graded prices, so they come from PokemonPriceTracker
 * (eBay sales per grade), with the user's own API key:
 *
 *   GET https://www.pokemonpricetracker.com/api/v2/cards?search=…&includeEbay=true
 *   Authorization: Bearer <key>
 *
 * Graded sales sit under `ebay.salesByGrade` as `psa10`, `psa9`, `psa9_5`…,
 * each with a median / smart market price. The free plan has about 100
 * credits a day and a card with eBay data costs about 2, so: one search per
 * product, at most a few cards per search, at most PER_RUN products per run
 * and PER_DAY a day, and prices are kept for a week (PSA prices move slowly).
 *
 * Only Pokémon singles in the saved list are looked up (in the cart, partly,
 * or missing). What is sent: the card's name and number, with the key. The
 * condition → grade estimate itself is store.psaEstimate().
 */
(function (root) {
  'use strict';

  const { store } = root.CMCS;

  const API = 'https://www.pokemonpricetracker.com/api/v2/cards';
  const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
  /** A card that was not found is looked for again after this long. */
  const NOT_FOUND_MS = 3 * 24 * 60 * 60 * 1000;
  /** Cards that come back per search (each one costs credits). */
  const PER_SEARCH = 3;
  /** Products looked up per run, and per day, to stay well inside the free plan. */
  const PER_RUN = 15;
  const PER_DAY = 40;
  /** The API allows 60 requests a minute. */
  const PAUSE_MS = 1100;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const today = () => new Date().toISOString().slice(0, 10);

  const WANTED = new Set([store.STATUS.IN_CART, store.STATUS.PARTIAL, store.STATUS.MISSING]);
  const isPokemonSingle = (item) => item.game === 'Pokemon' && /\/Products\/Singles\//i.test(item.productUrl || '');

  /** Lower case, no accents, no punctuation: "Pokémon-ex (V.1)" → "pokemon ex". */
  function normalize(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\([^)]*\)/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** "058/102" and "58" are the same number; "TG05" stays itself. */
  function normalizeNumber(number) {
    const first = String(number || '').split('/')[0].trim().toLowerCase();
    return first.replace(/^0+(?=\d)/, '');
  }

  const cardNumber = (card) => card.cardNumber ?? card.number ?? card.localId ?? null;
  const cardSet = (card) => card.setName ?? (card.set && (card.set.name || card.set)) ?? card.expansion ?? null;

  /**
   * The search result that is this card: the same name, and the same number
   * (or, when either has no number, a set name that overlaps). Null when unsure:
   * better no price than the price of another card.
   */
  function pickMatch(item, cards) {
    const name = normalize(item.name);
    const number = normalizeNumber(item.number);
    const setWords = new Set(normalize(item.expansion).split(' ').filter((w) => w.length > 1));
    let best = null;
    for (const card of cards || []) {
      const candidate = normalize(card.name);
      if (!candidate || !name || !(candidate === name || candidate.startsWith(`${name} `) || name.startsWith(`${candidate} `))) continue;
      const theirNumber = normalizeNumber(cardNumber(card));
      const numberMatch = Boolean(number && theirNumber && number === theirNumber);
      const setOverlap = normalize(cardSet(card)).split(' ').filter((w) => setWords.has(w)).length;
      if (number && theirNumber && !numberMatch) continue;
      if (!numberMatch && !setOverlap) continue;
      const score = (numberMatch ? 4 : 0) + setOverlap + (candidate === name ? 1 : 0);
      if (!best || score > best.score) best = { card, score };
    }
    return best ? best.card : null;
  }

  /** PSA prices of one card: { '10': { price, count }, '9.5': …, '9': … }. */
  function gradesOf(card) {
    const byGrade = (card.ebay && (card.ebay.salesByGrade || card.ebay.graded)) || card.salesByGrade || {};
    const grades = {};
    for (const [key, sold] of Object.entries(byGrade)) {
      const m = key.toLowerCase().match(/^psa[\s_-]?(\d{1,2})(?:[._](5))?$/);
      if (!m || sold == null) continue;
      const grade = Number(m[1]) + (m[2] ? 0.5 : 0);
      const price =
        typeof sold === 'number'
          ? sold
          : (sold.smartMarketPrice && sold.smartMarketPrice.price) ?? sold.medianPrice ?? sold.averagePrice ?? sold.marketPrice ?? null;
      if (!(price > 0)) continue;
      grades[grade] = { price: Math.round(price * 100) / 100, count: typeof sold === 'object' ? sold.count ?? null : null };
    }
    return grades;
  }

  class ApiError extends Error {
    constructor(kind, message) {
      super(message || kind);
      this.kind = kind;
    }
  }

  async function search(item, key) {
    const query = [item.name.replace(/\([^)]*\)/g, ' ').trim(), item.number ? normalizeNumber(item.number) : item.expansion].filter(Boolean).join(' ');
    const url = `${API}?${new URLSearchParams({ search: query, includeEbay: 'true', limit: String(PER_SEARCH) })}`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, cache: 'no-store' });
    } catch (err) {
      throw new ApiError('network', err.message);
    }
    if (res.status === 401 || res.status === 403) throw new ApiError('key', `HTTP ${res.status}`);
    if (res.status === 429) throw new ApiError('limit', 'HTTP 429');
    if (!res.ok) throw new ApiError('http', `HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    const data = body && (body.data ?? body.cards ?? body.results);
    return Array.isArray(data) ? data : data ? [data] : [];
  }

  /** One look-up round at a time: two at once would pay twice for the same card. */
  let running = null;
  function refresh(opts) {
    if (!running) running = lookUp(opts).finally(() => (running = null));
    return running;
  }

  /**
   * Look up the graded prices of Pokémon cards on the list that have none (or
   * an old one). `force` also runs when the daily allowance looks used up.
   */
  async function lookUp({ force = false } = {}) {
    const settings = await store.getSettings();
    const key = String(settings.pptApiKey || '').trim();
    if (!settings.psaEstimate || !key) return null;
    const saved = await store.getPsa();
    const cards = { ...(saved.cards || {}) };
    const status = { ...(saved.status || {}) };
    if (status.day !== today()) Object.assign(status, { day: today(), lookups: 0 });
    // Switched on in another browser (sync), not allowed here yet: the settings page asks.
    if (!(await store.hasOrigin(store.ORIGINS.psa))) {
      Object.assign(status, { at: Date.now(), error: 'permission', errorDetail: null });
      await chrome.storage.local.set({ [store.KEYS.psa]: { cards, status } });
      return status;
    }

    const now = Date.now();
    const items = Object.values(await store.getItems()).filter((item) => isPokemonSingle(item) && WANTED.has(item.status) && store.psaBand(item));
    const todo = [];
    const seen = new Set();
    // What is in the cart first, then what can go back.
    items.sort((a, b) => (a.status === store.STATUS.MISSING) - (b.status === store.STATUS.MISSING));
    for (const item of items) {
      const k = store.psaKey(item);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const entry = cards[k];
      const age = entry ? now - (entry.at || 0) : Infinity;
      if (entry && age < (entry.notFound ? NOT_FOUND_MS : FRESH_MS)) continue;
      todo.push({ key: k, item });
    }

    const room = force ? PER_RUN : Math.min(PER_RUN, PER_DAY - (status.lookups || 0));
    const batch = todo.slice(0, Math.max(0, room));
    let found = 0;
    let error = null;
    for (const [i, { key: k, item }] of batch.entries()) {
      if (i) await sleep(PAUSE_MS);
      try {
        const match = pickMatch(item, await search(item, key));
        status.lookups = (status.lookups || 0) + 1;
        const grades = match ? gradesOf(match) : {};
        cards[k] = match
          ? {
              at: Date.now(),
              grades,
              currency: 'USD',
              match: { name: match.name || null, set: cardSet(match), number: cardNumber(match) },
            }
          : { at: Date.now(), notFound: true, grades: {} };
        if (match) found += 1;
      } catch (err) {
        // A refused key or a used-up allowance: stop, and say so in the settings.
        error = err.kind || 'network';
        status.errorDetail = err.message;
        break;
      }
    }
    Object.assign(status, {
      at: Date.now(),
      error,
      errorDetail: error ? status.errorDetail : null,
      looked: batch.length,
      found,
      waiting: Math.max(0, todo.length - batch.length),
      known: Object.values(cards).filter((entry) => !entry.notFound).length,
    });
    await chrome.storage.local.set({ [store.KEYS.psa]: { cards, status } });
    return status;
  }

  let timer = null;
  /** After the list changed: look up new cards a little later, once. */
  function refreshSoon(delayMs = 15000) {
    clearTimeout(timer);
    timer = setTimeout(() => refresh().catch(() => {}), delayMs);
  }

  /** Switched off (or the key removed): forget every graded price. */
  const clear = () => chrome.storage.local.remove(store.KEYS.psa);

  root.CMCS.psa = { refresh, refreshSoon, clear, pickMatch, gradesOf, normalizeNumber };
})(globalThis);
