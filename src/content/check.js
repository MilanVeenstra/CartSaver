/*
 * "Are my articles still for sale?" — on request (the refresh button), look up
 * every saved article that is not in the cart, and every favourite, on
 * Cardmarket itself:
 *
 * 1. the seller's own stock, searched for the article's name (one page); when
 *    the offer is not there,
 * 2. the product page, filtered like the article (language, condition, foil).
 *
 * Found: its price goes into the price history, a sold article that is back
 * becomes "can go back" again. Marked sold only when a page that would show
 * it plainly does not: the seller's stock page when it is that whole stock
 * (no other pages, the search took), or the product page when it lists every
 * offer like it (no "Show more results"). Anything less sure (only the first
 * 50 offers, a page that did not load) changes nothing.
 * Requests are spaced like a refill; a Cloudflare check or a rate limit stops
 * the round. Progress and the outcome live in cmcs.check, so the popup and
 * every panel show the same.
 */
(function (root) {
  'use strict';

  const CMCS = (root.CMCS = root.CMCS || {});
  const { cm, store, t } = CMCS;

  /** At most this many articles per round (two page requests each, at most). */
  const MAX_PER_ROUND = 30;
  /** A "pending" round (asked for from the popup, no Cardmarket tab open yet) is picked up this long. */
  const PENDING_TTL_MS = 5 * 60 * 1000;
  /** A round that says "running" but did not move for this long lost its tab. */
  const STALE_MS = 2 * 60 * 1000;
  const JITTER_MS = 400;
  /** A seller's stock page with this many rows may well go on on a next page. */
  const FULL_PAGE = 20;
  /** A product page shows this many offers, then "Show more results". */
  const PRODUCT_PAGE = 50;

  /** A live round writes at least this often (one article: two pages and a pause). */
  const QUIET_MS = 30 * 1000;

  let running = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Incognito tabs have their own locks: a round is only judged by tabs on its own side. */
  const incognito = () => Boolean(root.chrome && chrome.extension && chrome.extension.inIncognitoContext);

  const isStale = (check) => Boolean(check && (check.state === 'running' || check.state === 'pending') && Date.now() - (check.heartbeatAt || check.at || 0) > STALE_MS);
  const isActive = (check) => Boolean(check && (check.state === 'running' || check.state === 'pending') && !isStale(check));

  const targetsOf = (items, favorites) => store.checkTargets(items, favorites, MAX_PER_ROUND);

  const rowsOf = (doc, baseUrl) => [...doc.querySelectorAll(cm.OFFER_ROWS)].map((row) => cm.parseOfferRow(row, { baseUrl })).filter(Boolean);

  /** For comparing names: no accents, case or extra spaces. */
  const plain = (text) =>
    String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  const samePath = (a, b) => {
    try {
      const path = (url) => decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '').toLowerCase();
      return path(a) === path(b);
    } catch {
      return false;
    }
  };

  /**
   * The seller's stock, searched for the article's name. `complete` when the
   * page plainly is that whole stock: still the seller's page (not sent on
   * elsewhere), its offers table there, every row the searched name (so the
   * search took), and no sign of a next page. Then "not there" means sold.
   */
  async function stockPage(url, article) {
    const { doc, url: finalUrl } = await cm.fetchDocument(url);
    const offers = rowsOf(doc, finalUrl);
    const offer = offers.find((o) => o.articleId === article.articleId);
    if (offer) return { offer };
    const name = plain(article.name);
    const searched = Boolean(name) && !name.startsWith('#') && offers.length > 0 && offers.every((o) => plain(o.name).includes(name));
    const paged = offers.length >= FULL_PAGE || Boolean(doc.querySelector('.pagination, a[href*="site="], [data-page]'));
    const table = Boolean(doc.querySelector('#UserOffersTable, .article-table'));
    return { complete: samePath(url, finalUrl) && table && searched && !paged };
  }

  /**
   * The product page, filtered like the article. `real` when it is that
   * product page with its offers table (so an empty one means: none for sale);
   * `whole` when it lists every such offer (no "Show more results").
   */
  async function productPage(url) {
    const { doc, url: finalUrl } = await cm.fetchDocument(url);
    const offers = rowsOf(doc, finalUrl);
    const real = samePath(url, finalUrl) && (offers.length > 0 || Boolean(doc.querySelector('.article-table, .table-body')));
    const more = Boolean(doc.querySelector('#loadMore, #loadMoreButton, [data-ajax-action="Product_LoadMoreArticles"]'));
    return { offers, real, whole: real && !more && offers.length < PRODUCT_PAGE };
  }

  const stopsRound = (err) => err && (err.kind === 'challenge' || err.kind === 'rate_limited');

  /**
   * Where is this offer now? `{ offer }` when found; `{ gone: true }` when a
   * page that would show it plainly does not; `{}` when that cannot be said.
   */
  async function locate(article, pause) {
    let sellerSaysGone = false;
    const sellerUrl = cm.sellerSearchUrl(article);
    if (sellerUrl) {
      try {
        const stock = await stockPage(sellerUrl, article);
        if (stock.offer) return { offer: stock.offer };
        sellerSaysGone = stock.complete;
      } catch (err) {
        if (stopsRound(err)) throw err;
      }
    }
    const productUrl = cm.alternativesUrl(article);
    if (!productUrl) return sellerSaysGone ? { gone: true } : {};
    if (sellerUrl) await pause();
    let product;
    try {
      product = await productPage(productUrl);
    } catch (err) {
      if (stopsRound(err)) throw err;
      return sellerSaysGone ? { gone: true } : {};
    }
    const offer = product.offers.find((o) => o.articleId === article.articleId);
    if (offer) return { offer };
    if (sellerSaysGone) return { gone: true };
    // Only the whole list says it is gone: the first 50 offers of many may
    // well leave it out (the same price as the last one shown, a price that
    // went up since, an order that is not quite by price).
    return product.whole ? { gone: true } : {};
  }

  /** Write what was found about one article; returns what it means for the outcome. */
  async function apply(target, found, now) {
    const { kind, article } = target;
    const id = article.articleId;
    if (found.offer) {
      const seen = found.offer;
      const priced = store.notePrice(article, seen.price, now);
      const up = priced !== article && priced.priceChange && priced.priceChange.at === now && priced.priceChange.to > priced.priceChange.from;
      const prices = priced !== article ? { price: priced.price, priceHistory: priced.priceHistory, priceChange: priced.priceChange } : {};
      const lastCheck = { at: now, ok: true, available: seen.available || null };
      if (kind === 'item') {
        const back = article.status === store.STATUS.UNAVAILABLE;
        await store.updateItems((items) => {
          const current = items[id];
          if (!current) return undefined;
          const next = { ...current, ...prices, lastCheck, comment: seen.comment || current.comment || null };
          // Sold before, for sale again: it can go back.
          if (back && current.status === store.STATUS.UNAVAILABLE) Object.assign(next, { status: store.STATUS.MISSING, lastAttempt: null });
          return { ...items, [id]: next };
        });
        // The same article starred: the favourites tab says the same, with the price in its own history.
        await store.updateFavorites((favorites) => {
          const fav = favorites[id];
          if (!fav) return undefined;
          return { ...favorites, [id]: { ...store.notePrice(fav, seen.price, now), lastCheck, unavailable: false, unavailableMessage: null, lastSeenAt: now } };
        });
        return { forSale: 1, back: back ? 1 : 0, up: up ? 1 : 0 };
      }
      await store.patchFavorites({
        [id]: { ...prices, lastCheck, available: seen.available || article.available || null, unavailable: false, unavailableMessage: null, lastSeenAt: now },
      });
      return { forSale: 1, up: up ? 1 : 0 };
    }
    if (found.gone) {
      const lastCheck = { at: now, ok: false };
      if (kind === 'item') {
        await store.updateItems((items) => {
          const current = items[id];
          if (!current) return undefined;
          const next = { ...current, lastCheck };
          if (current.status === store.STATUS.MISSING) {
            Object.assign(next, { status: store.STATUS.UNAVAILABLE, lastAttempt: { at: now, ok: false, reason: 'sold', message: t('checkGone') } });
          }
          return { ...items, [id]: next };
        });
      }
      // A favourite, or a saved article that is also starred.
      await store.patchFavorites({ [id]: { lastCheck, unavailable: true, unavailableMessage: t('checkGone') } });
      return { gone: 1 };
    }
    const lastCheck = { at: now, ok: null };
    if (kind === 'item') await store.patchItems({ [id]: { lastCheck } });
    await store.patchFavorites({ [id]: { lastCheck } });
    return { unsure: 1 };
  }

  async function run({ fromPending = false } = {}) {
    if (fromPending) {
      // Stopped (or taken by another tab) while it waited for this one.
      const waiting = await store.getCheck();
      if (!waiting || waiting.state !== 'pending' || waiting.cancel) return;
    }
    const [items, favorites, settings] = await Promise.all([store.getItems(), store.getFavorites(), store.getSettings()]);
    const targets = targetsOf(items, favorites);
    const counts = { checked: 0, forSale: 0, gone: 0, back: 0, up: 0, unsure: 0 };
    const started = Date.now();
    await store.setCheck({ state: 'running', at: started, heartbeatAt: started, total: targets.length, done: 0, current: null, counts, incognito: incognito() });
    // Only this round's own record: one that was ended elsewhere (or replaced) stops it.
    const mine = (check) => Boolean(check && check.at === started && check.state === 'running');
    const pause = () => sleep(settings.delayMs + Math.random() * JITTER_MS);
    let outcome = { state: 'done' };
    for (const [i, target] of targets.entries()) {
      const now = await store.getCheck();
      if (!mine(now)) return;
      if (now.cancel) {
        outcome = { state: 'cancelled' };
        break;
      }
      if (i) await pause();
      await store.updateCheck((check) => (mine(check) ? { ...check, heartbeatAt: Date.now(), current: target.article.name } : undefined));
      try {
        const found = await locate(target.article, pause);
        const result = await apply(target, found, Date.now());
        for (const [key, n] of Object.entries(result)) counts[key] += n;
        counts.checked += 1;
      } catch (err) {
        outcome = { state: 'error', error: err.kind || 'network' };
        break;
      }
      await store.updateCheck((check) => (mine(check) ? { ...check, heartbeatAt: Date.now(), done: i + 1, counts: { ...counts } } : undefined));
    }
    await store.updateCheck((check) => (mine(check) ? { ...check, ...outcome, current: null, counts: { ...counts }, finishedAt: Date.now(), heartbeatAt: Date.now() } : undefined));
  }

  /**
   * Start a round in this tab. Resolves at once ({ ok: true }) while the round
   * goes on; { ok: false, error } when one is already going ('checking') or a
   * refill is busy ('busy').
   */
  async function start({ fromPending = false } = {}) {
    if (running) return { ok: false, error: 'checking' };
    const [check, job] = await Promise.all([store.getCheck(), store.getJob()]);
    if (store.isJobActive(job)) return { ok: false, error: 'busy' };
    if (check && check.state === 'running' && !isStale(check)) return { ok: false, error: 'checking' };
    running = true;
    const go = () =>
      run({ fromPending })
        .catch(async (err) => {
          console.warn('[Cart Saver] check:', err);
          await store.updateCheck((c) => ({ ...(c || {}), state: 'error', error: 'network', finishedAt: Date.now() }));
        })
        .finally(() => (running = false));
    // One tab at a time, also when two ask at once.
    if (navigator.locks) {
      navigator.locks.request('cmcs.check', { ifAvailable: true }, (lock) => (lock ? go() : ((running = false), null)));
    } else {
      go();
    }
    return { ok: true };
  }

  /** Stop: after the article being looked at now, or before it starts. */
  const cancel = () => store.cancelCheck();

  /**
   * A round that says "running" while it went quiet and no tab holds it any
   * more (its tab was closed or went to another page) ends as stopped, so its
   * buttons come back. Every round holds the 'cmcs.check' lock from before it
   * says "running" until after it says how it ended; incognito tabs have
   * locks of their own, so only a tab on the round's own side judges it. And
   * should the round live on after all, it stops at its next article.
   */
  async function reapDead() {
    if (running || !navigator.locks || !navigator.locks.query) return false;
    const check = await store.getCheck();
    if (!check || check.state !== 'running' || Boolean(check.incognito) !== incognito()) return false;
    if (Date.now() - (check.heartbeatAt || check.at || 0) < QUIET_MS) return false;
    const { held = [] } = await navigator.locks.query();
    if (held.some((lock) => lock.name === 'cmcs.check')) return false;
    await store.updateCheck((current) =>
      current && current.state === 'running' && current.at === check.at
        ? { ...current, state: 'cancelled', cancel: true, current: null, finishedAt: Date.now(), heartbeatAt: Date.now() }
        : undefined,
    );
    return true;
  }

  let waitingForVisible = false;

  /** Cloudflare's "are you human" page (the real page follows once it passes). */
  const onChallengePage = () => cm.isChallenge(200, document.documentElement ? document.documentElement.outerHTML : '', null);

  /**
   * A round asked for from the popup while no Cardmarket tab was open: this
   * tab does it, once you can see it and it is the real site (not the
   * security check that may come first: the page after it picks it up).
   */
  async function resumePending() {
    const check = await store.getCheck();
    if (!check || check.state !== 'pending' || check.cancel || Date.now() - (check.at || 0) > PENDING_TTL_MS) return;
    if (document.visibilityState !== 'visible') {
      if (!waitingForVisible) {
        waitingForVisible = true;
        document.addEventListener('visibilitychange', function onVisible() {
          if (document.visibilityState !== 'visible') return;
          document.removeEventListener('visibilitychange', onVisible);
          waitingForVisible = false;
          resumePending();
        });
      }
      return;
    }
    if (onChallengePage()) return;
    await start({ fromPending: true });
  }

  CMCS.check = { start, cancel, resumePending, reapDead, isRunning: () => running, isActive, isStale, targetsOf, MAX_PER_ROUND };
})(globalThis);
