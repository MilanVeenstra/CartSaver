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
 * becomes "can go back" again. Not found where it should be: it is marked
 * sold. Not found on a product page that lists only cheaper offers: unsure,
 * nothing changes. Requests are spaced like a refill; a Cloudflare check or a
 * rate limit stops the round. Progress and the outcome live in cmcs.check, so
 * the popup and every panel show the same.
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

  let running = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isStale = (check) => Boolean(check && (check.state === 'running' || check.state === 'pending') && Date.now() - (check.heartbeatAt || check.at || 0) > STALE_MS);
  const isActive = (check) => Boolean(check && (check.state === 'running' || check.state === 'pending') && !isStale(check));

  const targetsOf = (items, favorites) => store.checkTargets(items, favorites, MAX_PER_ROUND);

  async function offersOn(url) {
    const { doc, url: finalUrl } = await cm.fetchDocument(url);
    return [...doc.querySelectorAll(cm.OFFER_ROWS)].map((row) => cm.parseOfferRow(row, { baseUrl: finalUrl })).filter(Boolean);
  }

  /**
   * Where is this offer now? `{ offer }` when found; `{ gone: true }` when a
   * page that should list it did not; `{}` when that cannot be said.
   */
  async function locate(article, pause) {
    let sellerRead = false;
    const sellerUrl = cm.sellerSearchUrl(article);
    if (sellerUrl) {
      try {
        const offer = (await offersOn(sellerUrl)).find((o) => o.articleId === article.articleId);
        if (offer) return { offer };
        sellerRead = true;
      } catch (err) {
        if (err.kind === 'challenge' || err.kind === 'rate_limited') throw err;
      }
    }
    const productUrl = cm.alternativesUrl(article);
    if (!productUrl) return sellerRead ? { gone: true } : {};
    if (sellerUrl) await pause();
    let offers;
    try {
      offers = await offersOn(productUrl);
    } catch (err) {
      if (err.kind === 'challenge' || err.kind === 'rate_limited') throw err;
      return sellerRead ? { gone: true } : {};
    }
    const offer = offers.find((o) => o.articleId === article.articleId);
    if (offer) return { offer };
    // The seller's own stock is the strongest sign. A product page shows the
    // cheapest offers first: one that lists only cheaper ones may go on below.
    const priced = offers.map((o) => o.price).filter((p) => p != null);
    const mayBeBelow = article.price != null && priced.length > 0 && Math.max(...priced) < article.price;
    return sellerRead || !mayBeBelow ? { gone: true } : {};
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
      } else {
        await store.patchFavorites({ [id]: { lastCheck, unavailable: true, unavailableMessage: t('checkGone') } });
      }
      return { gone: 1 };
    }
    const lastCheck = { at: now, ok: null };
    if (kind === 'item') await store.patchItems({ [id]: { lastCheck } });
    else await store.patchFavorites({ [id]: { lastCheck } });
    return { unsure: 1 };
  }

  async function run() {
    const [items, favorites, settings] = await Promise.all([store.getItems(), store.getFavorites(), store.getSettings()]);
    const targets = targetsOf(items, favorites);
    const counts = { checked: 0, forSale: 0, gone: 0, back: 0, up: 0, unsure: 0 };
    const started = Date.now();
    await store.setCheck({ state: 'running', at: started, heartbeatAt: started, total: targets.length, done: 0, current: null, counts });
    const pause = () => sleep(settings.delayMs + Math.random() * JITTER_MS);
    let outcome = { state: 'done' };
    for (const [i, target] of targets.entries()) {
      const now = await store.getCheck();
      if (now && now.cancel) {
        outcome = { state: 'cancelled' };
        break;
      }
      if (i) await pause();
      await store.updateCheck((check) => (check ? { ...check, heartbeatAt: Date.now(), current: target.article.name } : undefined));
      try {
        const found = await locate(target.article, pause);
        const result = await apply(target, found, Date.now());
        for (const [key, n] of Object.entries(result)) counts[key] += n;
        counts.checked += 1;
      } catch (err) {
        outcome = { state: 'error', error: err.kind || 'network' };
        break;
      }
      await store.updateCheck((check) => (check ? { ...check, heartbeatAt: Date.now(), done: i + 1, counts: { ...counts } } : undefined));
    }
    await store.updateCheck((check) => ({ ...(check || {}), ...outcome, current: null, counts: { ...counts }, finishedAt: Date.now(), heartbeatAt: Date.now() }));
  }

  /**
   * Start a round in this tab. Resolves at once ({ ok: true }) while the round
   * goes on; { ok: false, error } when one is already going or a refill is busy.
   */
  async function start() {
    if (running) return { ok: false, error: 'busy' };
    const [check, job] = await Promise.all([store.getCheck(), store.getJob()]);
    if (store.isJobActive(job)) return { ok: false, error: 'busy' };
    if (check && check.state === 'running' && !isStale(check)) return { ok: false, error: 'busy' };
    running = true;
    const go = () =>
      run()
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

  /** Stop after the article being looked at now. */
  const cancel = () => store.updateCheck((check) => (check ? { ...check, cancel: true } : undefined));

  /** A round asked for from the popup while no Cardmarket tab was open: this tab does it. */
  async function resumePending() {
    const check = await store.getCheck();
    if (!check || check.state !== 'pending' || Date.now() - (check.at || 0) > PENDING_TTL_MS) return;
    await start();
  }

  CMCS.check = { start, cancel, resumePending, isActive, isStale, targetsOf, MAX_PER_ROUND };
})(globalThis);
