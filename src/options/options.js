(async function options() {
  'use strict';

  const { store, ui, t } = CMCS;
  const $ = (id) => document.getElementById(id);

  const style = document.createElement('style');
  style.textContent = ui.STYLES;
  document.head.prepend(style);
  await CMCS.i18n.ready;
  CMCS.localize(document);
  $('logo').append(ui.logo(44));
  const shownLang = CMCS.lang();
  document.documentElement.lang = shownLang;

  // --- Settings --------------------------------------------------------------

  function fillForm(settings) {
    $('autoTrack').checked = settings.autoTrack;
    $('showReminder').checked = settings.showReminder;
    $('notify').checked = settings.notify;
    $('awayChecks').checked = settings.awayChecks;
    $('priceTrend').checked = settings.priceTrend;
    $('psaEstimate').checked = settings.psaEstimate;
    $('cloudSync').checked = settings.cloudSync;
    $('pptApiKey').value = settings.pptApiKey || '';
    $('delay').value = (settings.delayMs / 1000).toFixed(1);
  }
  fillForm(await store.getSettings());

  let savedTimer = null;
  async function save(patch) {
    await store.saveSettings(patch);
    $('saved').textContent = t('settingsSaved');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('saved').textContent = ''), 1800);
  }

  // Language: automatic (the browser's), Dutch or English. The page starts over in the new language.
  function paintLanguage() {
    for (const button of $('language').querySelectorAll('[data-lang]')) {
      button.setAttribute('aria-pressed', String(button.dataset.lang === CMCS.i18n.chosen()));
    }
  }
  paintLanguage();
  $('language').addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (button && button.dataset.lang !== CMCS.i18n.chosen()) save({ language: button.dataset.lang });
  });
  CMCS.i18n.onChange((lang) => (lang === shownLang ? paintLanguage() : location.reload()));

  $('autoTrack').addEventListener('change', (e) => save({ autoTrack: e.target.checked }));
  $('showReminder').addEventListener('change', (e) => save({ showReminder: e.target.checked }));
  $('notify').addEventListener('change', (e) => save({ notify: e.target.checked }));
  $('awayChecks').addEventListener('change', (e) => save({ awayChecks: e.target.checked }));

  // The opt-in features each talk to one more website. Chrome asks you for it
  // when you switch the feature on; switched off, the permission goes again.
  const HOSTS = { trend: 'downloads.s3.cardmarket.com', psa: 'www.pokemonpricetracker.com' };
  function optIn(box, origin, setting, statusEl) {
    box.addEventListener('change', async (e) => {
      const on = e.target.checked;
      if (on) {
        // Asked straight from the click: Chrome only asks during one.
        const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
        if (!granted) {
          e.target.checked = false;
          statusEl.textContent = t('permissionRefused');
          return;
        }
      }
      await save({ [setting]: on });
      if (!on) chrome.permissions.remove({ origins: [origin] }).catch(() => {});
    });
  }
  optIn($('priceTrend'), store.ORIGINS.trend, 'priceTrend', $('trendStatus'));
  // PSA values: the key is only kept here and sent to PokemonPriceTracker itself.
  optIn($('psaEstimate'), store.ORIGINS.psa, 'psaEstimate', $('psaStatus'));
  // On here (through sync, from another browser) but not allowed here yet.
  $('trendGrant').addEventListener('click', () => chrome.permissions.request({ origins: [store.ORIGINS.trend] }).then(renderTrendStatus, () => {}));
  $('psaGrant').addEventListener('click', () => chrome.permissions.request({ origins: [store.ORIGINS.psa] }).then(renderPsaStatus, () => {}));
  $('pptApiKey').addEventListener('change', (e) => {
    e.target.value = e.target.value.trim();
    save({ pptApiKey: e.target.value });
  });
  $('psaRefresh').addEventListener('click', async () => {
    $('psaStatus').textContent = t('psaStatusBusy');
    const reply = await chrome.runtime.sendMessage({ type: 'cmcs.psaRefresh' }).catch(() => null);
    if (!reply || !reply.status) $('psaStatus').textContent = t('psaStatusOff');
    renderPsaStatus();
  });

  // Your other browsers.
  $('cloudSync').addEventListener('change', (e) => save({ cloudSync: e.target.checked }));
  $('syncNow').addEventListener('click', async () => {
    $('syncStatus').textContent = t('syncBusy');
    await chrome.runtime.sendMessage({ type: 'cmcs.syncNow' }).catch(() => null);
    renderSyncStatus();
  });
  async function renderSyncStatus() {
    const current = await store.getSettings();
    $('syncBox').hidden = !current.cloudSync;
    const { 'cmcs.sync': state } = await chrome.storage.local.get('cmcs.sync');
    const status = state && state.status;
    if (!current.cloudSync || !status) {
      $('syncStatus').textContent = current.cloudSync ? t('syncNotYet') : '';
      return;
    }
    const when = new Date(status.at).toLocaleString(CMCS.locale(), { dateStyle: 'short', timeStyle: 'short' });
    const kb = (status.bytes || 0) < 1024 ? '<1' : String(Math.round(status.bytes / 1024));
    $('syncStatus').textContent = status.error
      ? t('syncError', status.error)
      : [t('syncStatus', when, kb), status.skipped ? t('syncFull', String(status.skipped)) : null].filter(Boolean).join(' ');
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes['cmcs.sync'] || changes[store.KEYS.settings])) renderSyncStatus();
  });
  renderSyncStatus();

  /** What the last look-up found, or why it stopped. */
  async function renderPsaStatus() {
    const current = await store.getSettings();
    const { status } = await store.getPsa();
    const allowed = await store.hasOrigin(store.ORIGINS.psa);
    $('psaKeyBox').hidden = !current.psaEstimate;
    $('psaGrant').hidden = !current.psaEstimate || allowed;
    if (!current.psaEstimate) {
      $('psaStatus').textContent = '';
      return;
    }
    if (!allowed) {
      $('psaStatus').textContent = t('permissionNeeded', HOSTS.psa);
      return;
    }
    if (!String(current.pptApiKey || '').trim()) {
      $('psaStatus').textContent = t('psaStatusNoKey');
      return;
    }
    if (!status || !status.at) return;
    const when = new Date(status.at).toLocaleString(CMCS.locale(), { dateStyle: 'short', timeStyle: 'short' });
    // "permission": allowed just now; the look-up it waited for is on its way.
    const errors = { key: 'psaErrorKey', limit: 'psaErrorLimit', permission: 'psaStatusBusy' };
    $('psaStatus').textContent = status.error
      ? t(errors[status.error] || 'psaErrorOther', status.errorDetail || status.error)
      : [CMCS.tn('psaStatus', status.known || 0, when, String(status.known || 0)), status.waiting ? t('psaStatusWaiting', String(status.waiting)) : null].filter(Boolean).join(' ');
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[store.KEYS.psa] || changes[store.KEYS.settings])) renderPsaStatus();
  });
  renderPsaStatus();

  /** When the price guide was last read, or why not. */
  async function renderTrendStatus() {
    const { 'cmcs.prices': status } = await chrome.storage.local.get('cmcs.prices');
    const on = (await store.getSettings()).priceTrend;
    const allowed = await store.hasOrigin(store.ORIGINS.trend);
    $('trendGrant').hidden = !on || allowed;
    if (on && !allowed) {
      $('trendStatus').textContent = t('permissionNeeded', HOSTS.trend);
      return;
    }
    if (!on || !status) {
      $('trendStatus').textContent = '';
      return;
    }
    const when = new Date(status.at).toLocaleString(CMCS.locale(), { dateStyle: 'short', timeStyle: 'short' });
    const cards = Object.values(status.games || {}).reduce((sum, n) => sum + n, 0);
    $('trendStatus').textContent = status.error === 'permission' ? t('psaStatusBusy') : status.error ? t('trendStatusError', status.error) : CMCS.tn('trendStatus', cards, when, String(cards));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes['cmcs.prices'] || changes[store.KEYS.settings])) renderTrendStatus();
  });
  chrome.permissions.onAdded.addListener(() => (renderTrendStatus(), renderPsaStatus()));
  chrome.permissions.onRemoved.addListener(() => (renderTrendStatus(), renderPsaStatus()));
  renderTrendStatus();
  $('delay').addEventListener('change', (e) => {
    const seconds = Math.min(10, Math.max(0.5, parseFloat(e.target.value) || 1.2));
    e.target.value = seconds.toFixed(1);
    save({ delayMs: Math.round(seconds * 1000) });
  });

  // --- Data ------------------------------------------------------------------

  async function renderSummary() {
    const [items, favorites, carts] = await Promise.all([store.getItems(), store.getFavorites(), store.getCarts()]);
    const summary = store.summarize(items);
    // Every article counted once: fully in the cart, partly, missing, sold, or ignored.
    $('dataSummary').textContent = t(
      'dataSummary',
      String(summary.total),
      String(summary.inCart - summary.partial),
      String(summary.partial),
      String(summary.missing),
      String(summary.unavailable),
      String(summary.ignored),
      CMCS.tn('countFavorites', Object.keys(favorites).length, Object.keys(favorites).length),
      CMCS.tn('countLists', carts.length, carts.length),
    );
  }
  store.onChanged(renderSummary);
  renderSummary();

  $('export').addEventListener('click', async () => {
    const payload = {
      format: 'cardmarket-cart-saver',
      version: 3,
      exportedAt: new Date().toISOString(),
      items: await store.getItems(),
      favorites: await store.getFavorites(),
      carts: await store.getCarts(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cart-saver-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /** Links in an imported file must point where they claim to; anything else is dropped. */
  function cleanLinks(item) {
    const safe = (value, test) => {
      if (typeof value !== 'string') return null;
      try {
        return test(new URL(value)) ? value : null;
      } catch {
        return null;
      }
    };
    const onCardmarket = (u) => u.protocol === 'https:' && u.hostname === 'www.cardmarket.com';
    const image = (u) => u.protocol === 'https:' && /(^|\.)cardmarket\.com$/.test(u.hostname);
    // Pictures are fetched again by the background; old exports may still carry copies.
    const { thumb, thumbTriedAt, ...rest } = item;
    return {
      ...rest,
      productUrl: safe(item.productUrl, onCardmarket),
      sellerUrl: safe(item.sellerUrl, onCardmarket),
      imageUrl: safe(item.imageUrl, image),
    };
  }

  $('import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const isArticle = (item) =>
        item && /^\d+$/.test(String(item.articleId)) && typeof item.name === 'string' && typeof item.game === 'string';
      const incoming = data && typeof data.items === 'object' ? data.items : data;
      const validItems = Object.values(incoming || {}).filter(isArticle).map(cleanLinks);
      const validFavorites = Object.values((data && data.favorites) || {}).filter(isArticle).map(cleanLinks);
      const validCarts = (Array.isArray(data && data.carts) ? data.carts : [])
        .filter((cart) => cart && typeof cart.id === 'string' && typeof cart.name === 'string' && Array.isArray(cart.items))
        .map((cart) => ({ ...cart, items: cart.items.filter(isArticle).map(cleanLinks) }))
        .filter((cart) => cart.items.length);
      if (!validItems.length && !validFavorites.length && !validCarts.length) throw new Error('nothing to import');
      let added = 0;
      let lists = 0;
      await store.updateItems((items) => {
        const next = { ...items };
        for (const item of validItems) {
          if (next[item.articleId]) continue;
          const keep = item.status === store.STATUS.UNAVAILABLE || item.status === store.STATUS.IGNORED;
          next[item.articleId] = { ...item, status: keep ? item.status : store.STATUS.MISSING };
          added += 1;
        }
        return next;
      });
      await store.updateFavorites((favorites) => {
        const next = { ...favorites };
        for (const fav of validFavorites) {
          if (next[fav.articleId]) continue;
          next[fav.articleId] = fav;
          added += 1;
        }
        return next;
      });
      if (validCarts.length) {
        await store.updateCarts((carts) => {
          const known = new Set(carts.map((cart) => cart.id));
          const fresh = validCarts.filter((cart) => !known.has(cart.id));
          lists += fresh.length;
          return [...carts, ...fresh].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        });
      }
      $('dataMessage').textContent = t('importDone', CMCS.tn('countArticles', added, added), CMCS.tn('countLists', lists, lists));
    } catch {
      $('dataMessage').textContent = t('importFailed');
    }
  });

  $('clear').addEventListener('click', async () => {
    if (!confirm(t('clearConfirm'))) return;
    const { language, cloudSync } = await store.getSettings();
    // Everything Cart Saver keeps in this browser: articles, favourites, lists, your
    // Cardmarket username, the API key, pictures and prices. The settings start
    // over; only the language and the sync switch stay as they are.
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((key) => key.startsWith('cmcs.') && key !== store.KEYS.settings));
    await chrome.storage.local.set({ [store.KEYS.settings]: { language, cloudSync } });
    // And the copy in your browser sync, also when syncing is off here. Your
    // other browsers that sync drop what came from it (they keep their own settings).
    if (chrome.storage.sync) await chrome.storage.sync.clear().catch(() => {});
    await chrome.permissions.remove({ origins: Object.values(store.ORIGINS) }).catch(() => {});
    fillForm(await store.getSettings());
    $('dataMessage').textContent = t('cleared');
  });
})();
