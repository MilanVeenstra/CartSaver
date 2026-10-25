/*
 * Storage + data model for saved cart items.
 *
 * Loaded as a classic script in every context (content script, popup, options
 * page and the background service worker), so it only touches `chrome.storage`
 * and never `window` / `document`.
 *
 * Saved items are keyed by Cardmarket's article id (one specific offer of one
 * seller). Items are never deleted automatically when they disappear from the
 * cart — that is the whole point: they are marked `missing` so they can be put
 * back later. Only an explicit user action, or seeing the article on an order
 * page (= it was bought), removes an item.
 */
(function (root) {
  'use strict';

  const CMCS = (root.CMCS = root.CMCS || {});

  /**
   * Websites only the opt-in features talk to. They are asked for when you
   * switch the feature on, so a new install only asks for Cardmarket.
   */
  const ORIGINS = {
    trend: 'https://downloads.s3.cardmarket.com/*',
    psa: 'https://www.pokemonpricetracker.com/*',
  };

  /** May the extension reach `origin` (one of ORIGINS)? */
  async function hasOrigin(origin) {
    try {
      return await chrome.permissions.contains({ origins: [origin] });
    } catch {
      return false;
    }
  }

  const KEYS = {
    items: 'cmcs.items',
    meta: 'cmcs.meta',
    job: 'cmcs.job',
    settings: 'cmcs.settings',
    favorites: 'cmcs.favorites',
    /** Named copies of the list ("Commander deck"), to put back later. */
    carts: 'cmcs.carts',
    /** Small copies of product pictures, by picture URL (made by the background). */
    thumbs: 'cmcs.thumbs',
    /** Graded (PSA) prices of Pokémon cards, by product (fetched by the background). */
    psa: 'cmcs.psa',
    /** The last check whether saved articles are still for sale (progress, then the outcome). */
    check: 'cmcs.check',
  };

  /** Saved lists; at this many, saving another is refused (never an old one dropped silently). */
  const MAX_CARTS = 100;

  const STATUS = {
    IN_CART: 'in_cart',
    /** In the cart, but fewer copies than wanted (e.g. the seller sold some). */
    PARTIAL: 'partial',
    MISSING: 'missing',
    UNAVAILABLE: 'unavailable',
    /**
     * Not in the cart, and you said to leave it (the offer is gone, you changed
     * your mind): it no longer counts anywhere, until it shows up in the cart again.
     */
    IGNORED: 'ignored',
  };

  /** Why an article left the cart, as far as a comparison of two readings can tell. */
  const REASON = {
    EMPTIED: 'emptied', // the whole cart went: expired, logged out, or bought elsewhere
    SELLER: 'seller', // every article of that seller went: removed by the seller, vacation, sold
    SINGLE: 'single', // only this article went while the seller's others stayed: probably sold
  };

  const DEFAULT_SETTINGS = {
    /** Save every article that shows up in the cart automatically. */
    autoTrack: true,
    /** Show the on-page reminder when saved articles fell out of the cart. */
    showReminder: true,
    /** Pause between two add-to-cart requests (a random 0–400 ms is added). */
    delayMs: 1200,
    /** Desktop notifications: the cart was emptied while you looked elsewhere, or is about to be. */
    notify: true,
    /** While you are at the computer and a Cardmarket tab is open, look at the cart every 10 minutes. */
    awayChecks: false,
    /** Compare prices with Cardmarket's public price guide (downloaded once a day). */
    priceTrend: false,
    /** Show an estimated PSA value for Pokémon cards (needs a PokemonPriceTracker API key). */
    psaEstimate: false,
    /** Your own PokemonPriceTracker API key; it never leaves this browser except to that API (not even through sync). */
    pptApiKey: '',
    /** Keep favourites, lists, saved articles and settings the same in all your browsers (your own browser sync). */
    cloudSync: true,
    /** The language Cart Saver speaks: 'auto' (the browser's), 'nl' or 'en'. */
    language: 'auto',
  };

  /**
   * What a Cardmarket condition is likely to get at PSA: the expected grade and
   * the band around it. Cardmarket's grading is the seller's own, and centring
   * or print lines are not part of it, so it stays an estimate. Near Mint
   * spans PSA 7 to 10.
   */
  const PSA_BY_CONDITION = {
    MT: { grade: 9, low: 8, high: 10 },
    NM: { grade: 8, low: 7, high: 10 },
    EX: { grade: 6, low: 5, high: 7 },
    GD: { grade: 4, low: 3, high: 5 },
    LP: { grade: 3, low: 2, high: 4 },
    PL: { grade: 2, low: 1, high: 3 },
    PO: { grade: 1, low: 1, high: 2 },
  };
  /** Cardmarket's condition ids (1 = Mint … 7 = Poor). */
  const CONDITION_CODES = [null, 'MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

  /** Unavailable and ignored articles leave the list on their own after this long. */
  const UNAVAILABLE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * A job counts as abandoned when its tab stopped sending heartbeats. Chrome
   * throttles timers in background tabs to about once a minute, so this must
   * stay well above that. (The real lock is a Web Lock held by the runner.)
   */
  const JOB_STALE_MS = 2 * 60 * 1000;
  /** A pending job (opened from the popup) must be picked up within this time. */
  const JOB_PENDING_TTL_MS = 2 * 60 * 1000;
  /** A favourite queued for the cart that no job tried by then is taken off the list again. */
  const UNTRIED_FAVORITE_MS = 3 * 60 * 1000;

  const storage = () => root.chrome.storage.local;

  async function get(key, fallback) {
    const result = await storage().get(key);
    return result[key] === undefined ? fallback : result[key];
  }

  async function set(key, value) {
    await storage().set({ [key]: value });
  }

  // Read-modify-write calls are queued per context so two quick updates from
  // the same page never overwrite each other.
  let queue = Promise.resolve();
  function update(key, fallback, fn) {
    const run = queue.then(async () => {
      const current = await get(key, fallback);
      const next = await fn(current);
      if (next !== undefined) await set(key, next);
      return next;
    });
    queue = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------------------
  // Pure helpers (no storage access) — easy to reason about and to test.
  // ---------------------------------------------------------------------------

  /** Price changes kept per article (the first known price always stays). */
  const PRICE_HISTORY_MAX = 30;
  /** Smaller differences are rounding, not a new price. */
  const PRICE_EPSILON = 0.005;

  const samePrice = (a, b) => a != null && b != null && Math.abs(a - b) < PRICE_EPSILON;

  /**
   * The prices an article had, oldest first: [{ at, price }]. Articles saved
   * before there was a history start with the price they have now.
   */
  function priceHistoryOf(article) {
    if (!article) return [];
    const list = Array.isArray(article.priceHistory) ? article.priceHistory.filter((p) => p && Number.isFinite(p.price)) : [];
    if (list.length || article.price == null) return list;
    return [{ at: article.firstSavedAt || article.favoritedAt || article.lastSeenInCartAt || null, price: article.price }];
  }

  /**
   * The article with a price just seen on Cardmarket (`at` = when): a new
   * price goes into its history and is flagged as a change (up or down).
   * The same price changes nothing. Returns the same object when nothing
   * changed, so callers can tell.
   */
  function notePrice(article, price, at = Date.now()) {
    if (!article || price == null || !Number.isFinite(price) || price <= 0) return article;
    const history = priceHistoryOf(article);
    const known = article.price;
    if (samePrice(known, price) && history.length) return article;
    const next = history.concat(samePrice(history.length ? history[history.length - 1].price : null, price) ? [] : [{ at, price }]);
    // Keep the first price (what it was when saved) and the latest ones.
    const trimmed = next.length > PRICE_HISTORY_MAX ? [next[0], ...next.slice(next.length - PRICE_HISTORY_MAX + 1)] : next;
    const changed = known != null && !samePrice(known, price);
    return {
      ...article,
      price,
      priceHistory: trimmed,
      priceChange: changed ? { from: known, to: price, at } : article.priceChange || null,
    };
  }

  /**
   * Merge a freshly read cart into the saved items.
   *
   * @param {Record<string, object>} items  saved items keyed by article id
   * @param {object[]} cartItems            articles currently in the cart
   * @param {object} opts
   * @param {number} opts.now
   * @param {boolean} opts.addNew           save articles we did not know yet
   * @param {boolean} opts.markMissing      mark saved articles absent from the cart
   */
  function applyCartSnapshot(items, cartItems, opts) {
    const next = { ...items };
    const seen = new Set();
    const added = [];
    const priceChanged = [];
    const accept = opts.acceptAmount || {};
    for (const cartItem of cartItems) {
      const id = cartItem.articleId;
      seen.add(id);
      const prev = next[id];
      if (!prev && !opts.addNew) continue;
      if (!prev) added.push(id);
      // How many copies the user wants: the most ever seen in the cart, unless
      // the user lowered it on purpose (then the new amount is what they want).
      const previousWanted = prev ? prev.wantedAmount || prev.amount || cartItem.amount : cartItem.amount;
      const wantedAmount = accept[id] ? cartItem.amount : Math.max(previousWanted, cartItem.amount);
      // The price: a new one goes into the history and is flagged (prev.price is what we knew).
      const priced = notePrice({ ...(prev || {}), firstSavedAt: (prev && prev.firstSavedAt) || opts.now }, cartItem.price, opts.now);
      if (prev && priced.priceChange !== (prev.priceChange || null) && priced.priceChange) priceChanged.push(id);
      next[id] = {
        ...(prev || {}),
        ...cartItem,
        price: cartItem.price != null ? cartItem.price : prev ? prev.price : null,
        priceHistory: priced.priceHistory || (prev && prev.priceHistory) || undefined,
        wantedAmount,
        priceChange: priced.priceChange || null,
        viaFavorite: false,
        firstSavedAt: (prev && prev.firstSavedAt) || opts.now,
        lastSeenInCartAt: opts.now,
        status: cartItem.amount < wantedAmount ? STATUS.PARTIAL : STATUS.IN_CART,
        missingSince: null,
        missingReason: null,
        ignoredAt: null,
        lastAttempt: (prev && prev.lastAttempt) || null,
      };
    }

    const newlyMissing = [];
    if (opts.markMissing) {
      const sellerKey = (item) => item.sellerId || item.sellerUrl || item.seller || '';
      const sellersInCart = new Set(cartItems.map(sellerKey));
      for (const [id, item] of Object.entries(next)) {
        // Cardmarket has one cart for all games: a reading speaks for every game.
        if (seen.has(id)) continue;
        if (item.status === STATUS.IN_CART || item.status === STATUS.PARTIAL) {
          const missingReason = !cartItems.length
            ? REASON.EMPTIED
            : sellersInCart.has(sellerKey(item))
              ? REASON.SINGLE
              : REASON.SELLER;
          next[id] = { ...item, status: STATUS.MISSING, missingSince: opts.now, missingReason };
          newlyMissing.push(id);
        }
      }
    }
    return { items: next, added, newlyMissing, priceChanged, inCart: seen.size };
  }

  /** Copies still to add to get back to what the user wanted. */
  function refillAmount(item) {
    const wanted = item.wantedAmount || item.amount || 1;
    if (item.status === STATUS.PARTIAL) return Math.max(1, wanted - (item.amount || 0));
    return wanted;
  }

  /** Copies that would go back for these articles. */
  const copiesToReturn = (list) => list.reduce((sum, item) => sum + refillAmount(item), 0);
  /** Copies of these articles that are in the cart now. */
  const copiesInCart = (list) =>
    list.reduce((sum, item) => sum + (item.status === STATUS.IN_CART || item.status === STATUS.PARTIAL ? item.amount || 1 : 0), 0);

  /** Counts per status, optionally limited to one game. */
  function summarize(items, game) {
    const summary = { total: 0, inCart: 0, partial: 0, missing: 0, unavailable: 0, ignored: 0, attention: 0, missingValue: 0 };
    for (const item of Object.values(items || {})) {
      if (game && item.game !== game) continue;
      summary.total += 1;
      if (item.status === STATUS.IN_CART) summary.inCart += 1;
      else if (item.status === STATUS.PARTIAL) {
        summary.inCart += 1;
        summary.partial += 1;
        summary.missingValue += (item.price || 0) * refillAmount(item);
      } else if (item.status === STATUS.UNAVAILABLE) summary.unavailable += 1;
      else if (item.status === STATUS.IGNORED) summary.ignored += 1;
      else {
        summary.missing += 1;
        summary.missingValue += (item.price || 0) * refillAmount(item);
      }
    }
    summary.attention = summary.missing + summary.partial;
    return summary;
  }

  /** Saved items that are not (fully) in the cart and worth trying to re-add. */
  function refillCandidates(items, { game, includeUnavailable = false } = {}) {
    return Object.values(items || {}).filter(
      (item) =>
        (!game || item.game === game) &&
        (item.status === STATUS.MISSING ||
          item.status === STATUS.PARTIAL ||
          (includeUnavailable && item.status === STATUS.UNAVAILABLE)),
    );
  }

  /**
   * What a check "still for sale?" looks at: saved articles out of the cart
   * (the longest unchecked first), then favourites that are not saved articles.
   */
  function checkTargets(items, favorites, max = 30) {
    const last = (a) => (a.lastCheck && a.lastCheck.at) || 0;
    const saved = Object.values(items || {})
      .filter((item) => item.status === STATUS.MISSING || item.status === STATUS.UNAVAILABLE)
      .sort((a, b) => last(a) - last(b))
      .map((article) => ({ kind: 'item', article }));
    const favs = Object.values(favorites || {})
      .filter((fav) => !(items || {})[fav.articleId])
      .sort((a, b) => last(a) - last(b))
      .map((article) => ({ kind: 'favorite', article }));
    return [...saved, ...favs].slice(0, max);
  }

  /** A stable signature of the missing set, used to remember a dismissed reminder. */
  function missingSignature(items, game) {
    return refillCandidates(items, { game })
      .map((item) => item.articleId)
      .sort()
      .join(',');
  }

  const FAVORITE_FIELDS = [
    'articleId', 'productId', 'game', 'lang', 'name', 'expansion', 'number', 'productUrl', 'imageUrl',
    'price', 'available', 'condition', 'conditionLabel', 'language', 'languageLabel', 'foil', 'extras',
    'comment', 'seller', 'sellerUrl',
  ];

  /** The part of an article worth keeping as a favourite. */
  function toFavorite(article, now = Date.now()) {
    const fav = {};
    for (const field of FAVORITE_FIELDS) if (article[field] !== undefined) fav[field] = article[field];
    const history = Array.isArray(article.priceHistory) && article.priceHistory.length ? article.priceHistory : fav.price != null ? [{ at: now, price: fav.price }] : [];
    return { ...fav, priceHistory: history, favoritedAt: now, lastSeenAt: now, unavailable: false, unavailableMessage: null };
  }

  /** The PSA band for an article's condition, or null (sealed products, unknown condition). */
  function psaBand(item) {
    if (!item) return null;
    // The badge ("NM") first; the condition id when the badge says something else.
    const codes = [String(item.conditionLabel || '').toUpperCase(), CONDITION_CODES[item.condition]];
    const code = codes.find((c) => c && PSA_BY_CONDITION[c]);
    return code ? { ...PSA_BY_CONDITION[code], condition: code } : null;
  }

  /** The key graded prices are kept under: one per product (every offer of it shares them). */
  function psaKey(item) {
    if (!item) return null;
    if (item.productId) return `p${item.productId}`;
    if (!item.productUrl) return null;
    try {
      // Without the site language: /en/ and /de/ are the same product.
      return new URL(item.productUrl).pathname.replace(/^\/[a-z]{2}\//, '/').toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * The estimate for one article from its product's graded prices: the expected
   * grade with its price (when sold at that grade), and every known price in the
   * band. Null when nothing in the band ever sold.
   */
  function psaEstimate(item, entry) {
    const band = psaBand(item);
    if (!band || !entry || !entry.grades) return null;
    const prices = Object.entries(entry.grades)
      .map(([grade, sold]) => ({ grade: Number(grade), price: sold && sold.price, count: (sold && sold.count) || null }))
      .filter((sold) => sold.price > 0 && sold.grade >= band.low && sold.grade <= band.high)
      .sort((a, b) => a.grade - b.grade);
    if (!prices.length) return null;
    const atGrade = prices.find((sold) => sold.grade === band.grade);
    return {
      ...band,
      price: atGrade ? atGrade.price : null,
      prices,
      min: Math.min(...prices.map((sold) => sold.price)),
      max: Math.max(...prices.map((sold) => sold.price)),
      currency: entry.currency || 'USD',
      match: entry.match || null,
    };
  }

  /** Does a favourite match a free-text search (name, expansion, seller…)? */
  function favoriteMatches(fav, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = [fav.name, fav.expansion, fav.seller, fav.game, fav.languageLabel, fav.conditionLabel, ...(fav.extras || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  }

  /** A refill job, before a Cardmarket tab claims and runs it. */
  function newJob(articleIds, lang) {
    const now = Date.now();
    return {
      id: `job-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      state: 'pending',
      lang: lang || 'en',
      articleIds,
      total: articleIds.length,
      done: 0,
      added: 0,
      failed: 0,
      results: {},
      error: null,
      createdAt: now,
      heartbeatAt: now,
      finishedAt: null,
      acknowledged: false,
    };
  }

  /** A job whose tab disappeared (closed, navigated away) before it finished. */
  function isJobInterrupted(job, now = Date.now()) {
    return Boolean(job && job.state === 'running' && now - (job.heartbeatAt || 0) >= JOB_STALE_MS);
  }

  function isJobActive(job, now = Date.now()) {
    if (!job) return false;
    if (job.state === 'running') return now - (job.heartbeatAt || 0) < JOB_STALE_MS;
    if (job.state === 'pending') return now - (job.createdAt || 0) < JOB_PENDING_TTL_MS;
    return false;
  }

  const GAME_NAMES = {
    Magic: 'Magic',
    Pokemon: 'Pokémon',
    YuGiOh: 'Yu-Gi-Oh!',
    OnePiece: 'One Piece',
    Lorcana: 'Lorcana',
    FleshAndBlood: 'Flesh and Blood',
    DragonBallSuper: 'Dragon Ball Super',
    Digimon: 'Digimon',
    StarWarsUnlimited: 'Star Wars: Unlimited',
    StarWarsDestiny: 'Star Wars: Destiny',
    FinalFantasy: 'Final Fantasy',
    WeissSchwarz: 'Weiß Schwarz',
    Vanguard: 'Vanguard',
    BattleSpiritsSaga: 'Battle Spirits Saga',
  };

  /** A game's name as people say it ("Pokemon" in the URL → "Pokémon"). */
  function gameName(slug) {
    if (!slug) return '';
    return GAME_NAMES[slug] || String(slug).replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /** Is a storage change nothing but a running job's heartbeat (nothing to redraw)? */
  function isHeartbeatOnly(changes) {
    const keys = Object.keys(changes || {});
    if (keys.length !== 1 || keys[0] !== KEYS.job) return false;
    const { oldValue, newValue } = changes[KEYS.job];
    if (!oldValue || !newValue) return false;
    const { heartbeatAt: a, ...before } = oldValue;
    const { heartbeatAt: b, ...after } = newValue;
    return JSON.stringify(before) === JSON.stringify(after);
  }

  /** Ids of unavailable and ignored articles nobody looked at for a month. */
  function staleIds(items, now = Date.now()) {
    return Object.values(items || {})
      .filter((item) => {
        if (item.status !== STATUS.UNAVAILABLE && item.status !== STATUS.IGNORED) return false;
        const last = Math.max(
          (item.lastAttempt && item.lastAttempt.at) || 0,
          item.missingSince || 0,
          item.lastSeenInCartAt || 0,
          item.ignoredAt || 0,
        );
        return last > 0 && now - last > UNAVAILABLE_KEEP_MS;
      })
      .map((item) => item.articleId);
  }

  function groupBy(list, keyFn) {
    const groups = new Map();
    for (const entry of list) {
      const key = keyFn(entry);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return groups;
  }

  function formatPrice(value) {
    if (value == null || !Number.isFinite(value)) return '';
    return `${value.toFixed(2).replace('.', ',')} €`;
  }

  /** One line per article: "2x Bojuka Bog (Commander 2018 #238) · NM · English · 0,99 € · snowc". */
  function exportText(list, { languageName = (item) => item.languageLabel } = {}) {
    return list
      .map((item) => {
        const set = [item.expansion, item.number ? `#${item.number}` : null].filter(Boolean).join(' ');
        return [
          `${item.wantedAmount || item.amount || 1}x ${item.name}${set ? ` (${set})` : ''}`,
          item.conditionLabel,
          languageName(item),
          ...(item.extras || []),
          formatPrice(item.price),
          item.seller,
        ]
          .filter(Boolean)
          .join(' · ');
      })
      .join('\n');
  }

  /**
   * A spreadsheet of the list (semicolons and decimal commas, as Excel expects
   * in Dutch). Column names and status words come from the caller, translated.
   */
  function exportCsv(list, { header, statusName = (status) => status || '', languageName = (item) => item.languageLabel } = {}) {
    const cell = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const columns = header || ['Name', 'Expansion', 'Number', 'Condition', 'Language', 'Extras', 'Amount', 'Price', 'Seller', 'Status', 'URL'];
    const rows = list.map((item) => [
      item.name,
      item.expansion,
      item.number,
      item.conditionLabel,
      languageName(item),
      (item.extras || []).join(', '),
      item.wantedAmount || item.amount || 1,
      item.price == null ? '' : item.price.toFixed(2).replace('.', ','),
      item.seller,
      statusName(item.status),
      item.productUrl,
    ]);
    return [columns, ...rows].map((row) => row.map(cell).join(';')).join('\r\n');
  }

  // ---------------------------------------------------------------------------
  // Storage API
  // ---------------------------------------------------------------------------

  const store = {
    KEYS,
    STATUS,
    ORIGINS,
    hasOrigin,
    REASON,
    DEFAULT_SETTINGS,
    JOB_STALE_MS,
    JOB_PENDING_TTL_MS,

    applyCartSnapshot,
    checkTargets,
    notePrice,
    priceHistoryOf,
    PRICE_HISTORY_MAX,
    summarize,
    refillAmount,
    copiesToReturn,
    copiesInCart,
    refillCandidates,
    missingSignature,
    newJob,
    isJobActive,
    isJobInterrupted,
    toFavorite,
    favoriteMatches,
    groupBy,
    gameName,
    isHeartbeatOnly,
    staleIds,
    exportText,
    exportCsv,
    formatPrice,
    PSA_BY_CONDITION,
    psaBand,
    psaKey,
    psaEstimate,

    getItems: () => get(KEYS.items, {}),
    setItems: (items) => set(KEYS.items, items),
    updateItems: (fn) => update(KEYS.items, {}, fn),

    async getSettings() {
      return { ...DEFAULT_SETTINGS, ...(await get(KEYS.settings, {})) };
    },
    async saveSettings(patch) {
      return update(KEYS.settings, {}, (current) => ({ ...current, ...patch }));
    },

    getMeta: () => get(KEYS.meta, {}),
    updateMeta: (fn) => update(KEYS.meta, {}, fn),

    getJob: () => get(KEYS.job, null),

    getCheck: () => get(KEYS.check, null),
    setCheck: (check) => set(KEYS.check, check),
    updateCheck: (fn) => update(KEYS.check, null, fn),
    setJob: (job) => set(KEYS.job, job),
    updateJob: (fn) => update(KEYS.job, null, fn),

    /**
     * Close the job panel. A job that still says "running" (its tab went away)
     * is ended for good, so it no longer shows as busy anywhere.
     */
    dismissJob: () =>
      update(KEYS.job, null, (job) => {
        if (!job) return undefined;
        if (job.state === 'running' || job.state === 'pending') {
          return { ...job, state: 'error', error: 'interrupted', acknowledged: true, finishedAt: job.finishedAt || Date.now() };
        }
        return { ...job, acknowledged: true };
      }),

    /** Store a freshly read cart. Returns what changed. */
    async syncCart(cartItems, { addNew, markMissing, acceptAmount }) {
      let result;
      await update(KEYS.items, {}, (items) => {
        result = applyCartSnapshot(items, cartItems, {
          addNew,
          markMissing,
          acceptAmount,
          now: Date.now(),
        });
        return result.items;
      });
      return result;
    },

    async removeItems(articleIds) {
      const ids = new Set(articleIds);
      return update(KEYS.items, {}, (items) => {
        const next = {};
        for (const [id, item] of Object.entries(items)) if (!ids.has(id)) next[id] = item;
        return next;
      });
    },

    async patchItems(patches) {
      return update(KEYS.items, {}, (items) => {
        const next = { ...items };
        for (const [id, patch] of Object.entries(patches)) {
          if (next[id]) next[id] = { ...next[id], ...patch };
        }
        return next;
      });
    },

    /**
     * Make sure articles exist as saved cart items so a refill job can add
     * them (favourites, a saved cart). Articles already (partly) in the cart
     * are left alone; others become "missing" with the wanted amount.
     * Favourites are added once (amount 1) and flagged, so a failed add can
     * drop them again instead of cluttering the cart list.
     */
    async ensureItems(articles, { viaFavorite = false } = {}) {
      return update(KEYS.items, {}, (items) => {
        const next = { ...items };
        const now = Date.now();
        for (const source of articles) {
          const prev = next[source.articleId];
          if (prev && (prev.status === STATUS.IN_CART || prev.status === STATUS.PARTIAL)) continue;
          const { favoritedAt, lastSeenAt, unavailable, unavailableMessage, available, ...article } = source;
          const wanted = viaFavorite ? 1 : source.wantedAmount || source.amount || 1;
          next[source.articleId] = {
            ...article,
            ...(prev || {}),
            amount: (prev && prev.amount) || wanted,
            wantedAmount: (prev && prev.wantedAmount) || wanted,
            status: STATUS.MISSING,
            missingReason: null,
            ignoredAt: null,
            viaFavorite: prev ? Boolean(prev.viaFavorite) : viaFavorite,
            firstSavedAt: (prev && prev.firstSavedAt) || now,
            missingSince: now,
          };
        }
        return next;
      });
    },

    ensureItemsFromFavorites(favorites) {
      return store.ensureItems(favorites, { viaFavorite: true });
    },

    /**
     * Favourites queued for the cart join the list as "missing" until a job
     * tries them. A job that never ran (logged out, cancelled, expired) would
     * leave them there, looking like cart articles: those go again, once
     * they are older than a queued job can wait. Resolves to the ids removed.
     */
    async sweepUntriedFavorites(job, now = Date.now()) {
      const waiting = job && store.isJobActive(job, now) ? new Set(job.articleIds || []) : new Set();
      const removed = [];
      await update(KEYS.items, {}, (items) => {
        const next = { ...items };
        for (const [id, item] of Object.entries(items)) {
          const untried = item.viaFavorite && item.status === STATUS.MISSING && !item.lastAttempt;
          if (untried && !waiting.has(id) && now - (item.missingSince || 0) > UNTRIED_FAVORITE_MS) {
            delete next[id];
            removed.push(id);
          }
        }
        return removed.length ? next : undefined;
      });
      return removed;
    },

    hasUntriedFavorites: (items) => Object.values(items || {}).some((item) => item.viaFavorite && item.status === STATUS.MISSING && !item.lastAttempt),

    /**
     * Stop counting articles that are not (fully) in the cart: no badge, no
     * reminder, not in "put back". What is gone becomes "ignored"; for an
     * article partly in the cart, what is there now becomes what you want.
     * Resolves to the articles as they were, for restoreIgnored() (undo).
     */
    async ignoreItems(articleIds, now = Date.now()) {
      const ids = new Set(articleIds);
      const before = [];
      await update(KEYS.items, {}, (items) => {
        const next = { ...items };
        for (const id of ids) {
          const item = items[id];
          if (!item) continue;
          if (item.status === STATUS.PARTIAL) {
            next[id] = { ...item, status: STATUS.IN_CART, wantedAmount: item.amount || 1 };
          } else if (item.status === STATUS.MISSING || item.status === STATUS.UNAVAILABLE) {
            next[id] = { ...item, status: STATUS.IGNORED, ignoredAt: now };
          } else continue;
          before.push(item);
        }
        return before.length ? next : undefined;
      });
      return before;
    },

    /** Undo ignoreItems(), unless the article changed since (back in the cart, removed). */
    restoreIgnored(list) {
      return update(KEYS.items, {}, (items) => {
        const next = { ...items };
        let changed = false;
        for (const item of list) {
          const now = items[item.articleId];
          if (!now) continue;
          if (now.status === STATUS.IGNORED) next[item.articleId] = item;
          else if (item.status === STATUS.PARTIAL && now.status === STATUS.IN_CART && (now.amount || 1) === (item.amount || 1)) {
            next[item.articleId] = { ...now, status: STATUS.PARTIAL, wantedAmount: item.wantedAmount };
          } else continue;
          changed = true;
        }
        return changed ? next : undefined;
      });
    },

    /** Remove items and hand them back, so the removal can be undone. */
    async takeItems(articleIds) {
      const ids = new Set(articleIds);
      const taken = [];
      await update(KEYS.items, {}, (items) => {
        const next = {};
        for (const [id, item] of Object.entries(items)) {
          if (ids.has(id)) taken.push(item);
          else next[id] = item;
        }
        return taken.length ? next : undefined;
      });
      return taken;
    },

    /** Put items taken with takeItems() back, unless the article came back meanwhile. */
    restoreItems(list) {
      return update(KEYS.items, {}, (items) => {
        const next = { ...items };
        for (const item of list) if (!next[item.articleId]) next[item.articleId] = item;
        return next;
      });
    },

    getCarts: () => get(KEYS.carts, []),
    updateCarts: (fn) => update(KEYS.carts, [], fn),

    MAX_CARTS,

    /**
     * Keep a named copy of articles (a "saved cart"), newest first. Resolves to
     * the cart, or null when there are MAX_CARTS already.
     */
    async saveCart(name, articles) {
      const now = Date.now();
      const cart = {
        id: `cart-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(name || '').trim().slice(0, 80) || new Date(now).toISOString().slice(0, 10),
        createdAt: now,
        game: new Set(articles.map((item) => item.game)).size === 1 ? articles[0].game : null,
        items: store.savedCopies(articles),
      };
      let saved = null;
      await update(KEYS.carts, [], (carts) => {
        if (carts.length >= MAX_CARTS) return undefined;
        saved = cart;
        return [cart, ...carts];
      });
      return saved;
    },

    /** The articles as a saved list keeps them: what they are, not how they are doing now. */
    savedCopies(articles) {
      return articles.map((item) => {
        const { status, missingSince, missingReason, lastAttempt, priceChange, priceHistory, viaFavorite, thumb, thumbTriedAt, ...rest } = item;
        return { ...rest, wantedAmount: item.wantedAmount || item.amount || 1 };
      });
    },

    /** Change one saved cart (rename, new articles…). */
    updateCart(id, fn) {
      return update(KEYS.carts, [], (carts) => (carts.some((cart) => cart.id === id) ? carts.map((cart) => (cart.id === id ? fn(cart) : cart)) : undefined));
    },

    removeCart: (id) => update(KEYS.carts, [], (carts) => carts.filter((cart) => cart.id !== id)),

    /** Remove a saved cart and hand it back, so the removal can be undone. */
    async takeCart(id) {
      let taken = null;
      await update(KEYS.carts, [], (carts) => {
        taken = carts.find((cart) => cart.id === id) || null;
        return taken ? carts.filter((cart) => cart.id !== id) : undefined;
      });
      return taken;
    },

    /** Put a cart taken with takeCart() back in its place (newest first). */
    restoreCart(cart) {
      return update(KEYS.carts, [], (carts) =>
        carts.some((c) => c.id === cart.id) ? undefined : [...carts, cart].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      );
    },

    getThumbs: () => get(KEYS.thumbs, {}),
    /** { cards: { [psaKey]: entry }, status } — see src/background/psa.js. */
    getPsa: () => get(KEYS.psa, {}),
    updateThumbs: (fn) => update(KEYS.thumbs, {}, fn),

    getFavorites: () => get(KEYS.favorites, {}),
    setFavorites: (favorites) => set(KEYS.favorites, favorites),
    updateFavorites: (fn) => update(KEYS.favorites, {}, fn),

    /** Star or unstar an article. Resolves to true when it is now a favourite. */
    async toggleFavorite(article) {
      let starred = false;
      await update(KEYS.favorites, {}, (favorites) => {
        const next = { ...favorites };
        if (next[article.articleId]) delete next[article.articleId];
        else {
          next[article.articleId] = toFavorite(article);
          starred = true;
        }
        return next;
      });
      return starred;
    },

    async removeFavorites(articleIds) {
      const ids = new Set(articleIds);
      return update(KEYS.favorites, {}, (favorites) => {
        const next = {};
        for (const [id, fav] of Object.entries(favorites)) if (!ids.has(id)) next[id] = fav;
        return next;
      });
    },

    /** Remove favourites and hand them back, so the removal can be undone. */
    async takeFavorites(articleIds) {
      const ids = new Set(articleIds);
      const taken = [];
      await update(KEYS.favorites, {}, (favorites) => {
        const next = {};
        for (const [id, fav] of Object.entries(favorites)) {
          if (ids.has(id)) taken.push(fav);
          else next[id] = fav;
        }
        return taken.length ? next : undefined;
      });
      return taken;
    },

    restoreFavorites(list) {
      return update(KEYS.favorites, {}, (favorites) => {
        const next = { ...favorites };
        for (const fav of list) if (!next[fav.articleId]) next[fav.articleId] = fav;
        return next;
      });
    },

    /** Merge fields into existing favourites; unknown ids are ignored. Skips the write when nothing changes. */
    async patchFavorites(patches) {
      return update(KEYS.favorites, {}, (favorites) => {
        let changed = false;
        const next = { ...favorites };
        for (const [id, patch] of Object.entries(patches)) {
          if (!next[id]) continue;
          const merged = { ...next[id], ...patch };
          if (JSON.stringify(merged) !== JSON.stringify(next[id])) {
            next[id] = merged;
            changed = true;
          }
        }
        return changed ? next : undefined;
      });
    },

    onChanged(callback) {
      root.chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') callback(changes);
      });
    },
  };

  CMCS.store = store;
})(globalThis);
