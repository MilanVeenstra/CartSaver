/*
 * The estimated PSA value next to each Pokémon card in Cardmarket's own
 * shopping cart ("PSA 8 ≈ $45 · 7–10: $30–$210"), when that is switched on in
 * the settings. The prices come from the background (src/background/psa.js);
 * this only draws them, under the card's name, and keeps them current.
 */
(function (root) {
  'use strict';

  const CMCS = (root.CMCS = root.CMCS || {});
  const { store, ui } = CMCS;

  const LABEL_CSS = `
    :host { display: block; }
    span { font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #141414; font-variant-numeric: tabular-nums; }
    span::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; background: #b3122b; vertical-align: 1px; }
  `;

  let items = {};

  function label(info) {
    const host = document.createElement('cmcs-psa');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = LABEL_CSS;
    const text = document.createElement('span');
    text.textContent = info.text;
    text.title = info.title;
    shadow.append(style, text);
    return host;
  }

  /** One label per cart row (rows that show twice, for desktop and mobile, each get one). */
  function paint() {
    document.querySelectorAll('tr[data-article-id]').forEach((tr) => {
      const old = tr.querySelector('cmcs-psa');
      const item = items[tr.getAttribute('data-article-id')];
      const info = item ? ui.psaInfo(item) : null;
      if (old && (!info || old.shadowRoot.querySelector('span').textContent !== info.text)) old.remove();
      if (!info || tr.querySelector('cmcs-psa')) return;
      (tr.querySelector('td.name') || tr.querySelector('td.info') || tr.lastElementChild).append(label(info));
    });
  }

  async function load() {
    const [saved, psa] = await Promise.all([store.getItems(), store.getPsa()]);
    items = saved;
    ui.setPsa(psa.cards);
    paint();
  }

  async function init(loc) {
    if (!loc.isCart) return;
    await load();
    store.onChanged((changes) => {
      if (changes[store.KEYS.psa] || changes[store.KEYS.items]) load();
    });
    // Cardmarket redraws rows (fewer copies, a removal): label the new ones too.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(paint, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  CMCS.psaLabels = { init };
})(globalThis);
