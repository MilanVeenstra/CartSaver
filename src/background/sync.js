/*
 * Keeping your saved data the same in all your browsers, through your own
 * browser account (Chrome: your Google account), with chrome.storage.sync.
 *
 * Nobody else sees it and nothing goes to a server of ours: every person's
 * data travels in their own browser sync. Synced: favourites, saved lists,
 * saved cart articles and settings. Not synced: pictures, prices (trend, PSA)
 * and what belongs to one browser (panel folded, notices…): those are made
 * again in every browser.
 *
 * How:
 * - Every favourite, list and article is its own small record ("f.<id>",
 *   "l.<id>", "i.<id>", and "s" for the settings), with short field names
 *   and without the parts of URLs every record shares. A list larger than
 *   one sync item is split in parts ("l.<id>~1", "~2"…).
 * - A three-way merge: for every record the last version both sides agreed
 *   on is remembered (as a hash, in cmcs.sync). Changed here only → sent;
 *   changed elsewhere only → taken; gone on one side while unchanged on the
 *   other → removed on this side too. Changed on both → the newest wins.
 * - That memory only counts for the synced copy it was made with: the copy
 *   carries an id ("_e"), and every browser leaves a mark of its own last
 *   write in it ("_w.<install>"). When the id is another one, or this
 *   browser's last write is not in it (a first meeting, a copy Chrome's own
 *   sync replaced after a while without sync, one emptied by removing the
 *   extension somewhere), both sides are joined and nothing is removed. Only
 *   "Delete everything" removes elsewhere: it leaves a new id that names the
 *   old one.
 * - Chrome sync allows ~100 KB, 8 KB per item, 512 items and 120 writes a
 *   minute: one set() and one remove() per round, rounds are batched, and
 *   when it is full the settings, favourites and lists go first; what does
 *   not fit stays only in this browser (and is said so in the settings).
 */
(function (root) {
  'use strict';

  const { store } = root.CMCS;

  const STATE_KEY = 'cmcs.sync';
  /** The id of the synced copy: { id, at } (and { cleared, prev: [old ids] } after "Delete everything"). */
  const EPOCH_KEY = '_e';
  /** "_w.<install>": { n, at }, a new n with every write of that browser. */
  const MARK_PREFIX = '_w.';
  /** Marks of browsers that did not write for this long are cleared away… */
  const MARK_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
  /** …so every browser that still runs renews its own at least this often. */
  const MARK_RENEW_MS = 30 * 24 * 60 * 60 * 1000;
  /** Stay under Chrome's 102,400 bytes and 512 items, with room to spare. */
  const BUDGET_BYTES = 92 * 1024;
  const MAX_RECORDS = 480;
  /** Chrome allows 8,192 bytes per item, key included: a record larger than SINGLE_BYTES is split in parts of PART_BYTES. */
  const SINGLE_BYTES = 7800;
  const PART_BYTES = 7000;

  const CM = 'https://www.cardmarket.com';
  const IMG = 'https://product-images.s3.cardmarket.com';

  /** Long field names → short ones in the synced records. */
  const SHORT = {
    articleId: 'a', productId: 'p', game: 'g', lang: 'l', name: 'n', expansion: 'e', number: 'nr',
    productUrl: 'u', imageUrl: 'im', amount: 'q', wantedAmount: 'w', price: 'pr', condition: 'c',
    conditionLabel: 'cl', language: 'la', languageLabel: 'll', foil: 'fo', extras: 'x', comment: 'cm',
    seller: 's', sellerUrl: 'su', sellerId: 'si', status: 'st', missingReason: 'mr', missingSince: 'ms',
    ignoredAt: 'ig', viaFavorite: 'vf', firstSavedAt: 'fs', replaces: 'rp', favoritedAt: 'fa',
    available: 'av', unavailable: 'un', unavailableMessage: 'um',
  };
  const LONG = Object.fromEntries(Object.entries(SHORT).map(([long, short]) => [short, long]));

  /** What travels of each kind of record. Everything else stays in this browser. */
  const ARTICLE = ['articleId', 'productId', 'game', 'lang', 'name', 'expansion', 'number', 'productUrl', 'imageUrl',
    'price', 'condition', 'conditionLabel', 'language', 'languageLabel', 'foil', 'extras', 'comment', 'seller', 'sellerUrl', 'sellerId'];
  const ITEM_FIELDS = [...ARTICLE, 'amount', 'wantedAmount', 'status', 'missingReason', 'missingSince', 'ignoredAt', 'viaFavorite', 'firstSavedAt', 'replaces'];
  const FAVORITE_FIELDS = [...ARTICLE, 'available', 'favoritedAt', 'unavailable', 'unavailableMessage'];
  const LIST_ITEM_FIELDS = [...ARTICLE, 'amount', 'wantedAmount'];
  /**
   * Settings that belong to one browser. The PokemonPriceTracker key is a
   * password of sorts: it stays in the browser it was typed into.
   */
  const LOCAL_SETTINGS = new Set(['cloudSync', 'pptApiKey']);

  /** Links from the synced copy: only to Cardmarket, over https (anything else is dropped). */
  function safeUrl(field, value) {
    if (typeof value !== 'string') return null;
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:') return null;
      if (field === 'imageUrl') return /(^|\.)cardmarket\.com$/.test(u.hostname) ? value : null;
      return u.hostname === 'www.cardmarket.com' ? value : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  const empty = (value) => value == null || value === '' || value === false || (Array.isArray(value) && !value.length);

  /**
   * JSON with the keys in a fixed order. Chrome hands synced objects back with
   * their keys sorted, so the same record must give the same text both ways.
   */
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function pack(source, fields) {
    const out = {};
    for (const field of fields) {
      let value = source[field];
      if (empty(value)) continue;
      if ((field === 'productUrl' || field === 'sellerUrl') && typeof value === 'string' && value.startsWith(CM)) value = value.slice(CM.length);
      if (field === 'imageUrl' && typeof value === 'string' && value.startsWith(IMG)) value = value.slice(IMG.length);
      out[SHORT[field] || field] = value;
    }
    return out;
  }

  /** Back to long names; fields the record leaves out are empty (null, false, none). */
  function unpack(packed, fields) {
    const out = {};
    for (const field of fields) {
      const value = packed[SHORT[field] || field];
      if (value === undefined) {
        out[field] = field === 'foil' || field === 'viaFavorite' || field === 'unavailable' ? false : field === 'extras' ? [] : null;
        continue;
      }
      if ((field === 'productUrl' || field === 'sellerUrl') && typeof value === 'string' && value.startsWith('/')) out[field] = safeUrl(field, CM + value);
      else if (field === 'imageUrl' && typeof value === 'string' && value.startsWith('/')) out[field] = safeUrl(field, IMG + value);
      else if (field === 'productUrl' || field === 'sellerUrl' || field === 'imageUrl') out[field] = safeUrl(field, value);
      else out[field] = value;
    }
    return out;
  }

  /** Lower comes first when sync is full. */
  function itemPriority(item) {
    if (item.status === store.STATUS.IN_CART || item.status === store.STATUS.PARTIAL) return 3;
    if (item.status === store.STATUS.MISSING) return 4;
    return 5;
  }

  /** Every record this browser would sync: key → { value, json, priority }. */
  function localRecords({ items, favorites, carts, settings }) {
    const records = new Map();
    const add = (key, value, priority, recent = 0) => records.set(key, { value, json: canonical(value), priority, recent });
    const shared = Object.fromEntries(Object.entries(settings).filter(([key]) => !LOCAL_SETTINGS.has(key)));
    add('s', shared, 0);
    for (const fav of Object.values(favorites || {})) if (fav && fav.articleId) add(`f.${fav.articleId}`, pack(fav, FAVORITE_FIELDS), 1, fav.favoritedAt || 0);
    for (const cart of carts || []) {
      if (!cart || !cart.id) continue;
      add(`l.${cart.id}`, { id: cart.id, n: cart.name, g: cart.game || undefined, ca: cart.createdAt, ua: cart.updatedAt || undefined, it: (cart.items || []).map((item) => pack(item, LIST_ITEM_FIELDS)) }, 2, cart.createdAt || 0);
    }
    for (const item of Object.values(items || {})) if (item && item.articleId) add(`i.${item.articleId}`, pack(item, ITEM_FIELDS), itemPriority(item), item.firstSavedAt || 0);
    return records;
  }

  /** The synced records, with split ones joined again: key → { value, json, u } or { incomplete }. */
  function remoteRecords(all) {
    const records = new Map();
    for (const [key, entry] of Object.entries(all || {})) {
      if (key.includes('~') || key.startsWith('_') || !entry || typeof entry !== 'object') continue;
      if (typeof entry.n === 'number' && typeof entry.s === 'string') {
        // A split record: its parts must all be there, or it waits for the next round.
        let json = entry.s;
        let complete = true;
        for (let i = 1; i < entry.n; i += 1) {
          const part = all[`${key}~${i}`];
          if (typeof part !== 'string') {
            complete = false;
            break;
          }
          json += part;
        }
        if (!complete) {
          records.set(key, { incomplete: true });
          continue;
        }
        try {
          const value = JSON.parse(json);
          records.set(key, { value, json: canonical(value), u: entry.u || 0 });
        } catch {
          records.set(key, { incomplete: true });
        }
      } else if ('v' in entry) {
        records.set(key, { value: entry.v, json: canonical(entry.v), u: entry.u || 0 });
      }
    }
    return records;
  }

  /**
   * What one character costs in Chrome's count: UTF-8, with "<", U+2028/9 and
   * DEL written as \uXXXX (Chrome's JSON does that), and inside a string (a
   * part of a split record) also '"' and '\' escaped.
   */
  function charBytes(ch, inString) {
    const c = ch.codePointAt(0);
    if (c === 0x3c || c === 0x2028 || c === 0x2029 || c === 0x7f) return 6;
    if (inString && (c === 0x22 || c === 0x5c)) return 2;
    if (inString && c < 0x20) return 6;
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }

  /** The bytes Chrome counts for a text (JSON) as it stores it. */
  function bytesOf(text) {
    let n = 0;
    for (const ch of String(text)) n += charBytes(ch, false);
    return n;
  }

  /** A record's JSON in parts that each stay under PART_BYTES once stored as a string (never inside a character). */
  function splitJson(json) {
    const parts = [];
    let current = '';
    let size = 2;
    for (const ch of json) {
      const cost = charBytes(ch, true);
      if (current && size + cost > PART_BYTES) {
        parts.push(current);
        current = '';
        size = 2;
      }
      current += ch;
      size += cost;
    }
    parts.push(current);
    return parts;
  }

  /** What one record takes in sync storage: key → value, split when it is too large. */
  function entriesFor(key, record, now) {
    const single = { [key]: { u: now, v: record.value } };
    if (bytesOf(key) + bytesOf(JSON.stringify(single[key])) < SINGLE_BYTES) return single;
    const parts = splitJson(record.json);
    const entries = { [key]: { u: now, n: parts.length, s: parts[0] } };
    parts.slice(1).forEach((part, i) => (entries[`${key}~${i + 1}`] = part));
    return entries;
  }

  const sizeOf = (entries) => Object.entries(entries).reduce((sum, [key, value]) => sum + bytesOf(key) + bytesOf(JSON.stringify(value)), 0);

  /** A short fingerprint of a record (FNV-1a), to remember what both sides agreed on. */
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${h.toString(36)}:${text.length}`;
  }

  // ---------------------------------------------------------------------------
  // Taking what came from elsewhere
  // ---------------------------------------------------------------------------

  /** A record from another browser over what this one knows, with its price noted in the history. */
  function withPriceFrom(local, incoming) {
    if (!local) return store.notePrice({ ...incoming }, incoming.price, Date.now()) || incoming;
    const priced = store.notePrice(local, incoming.price, Date.now());
    return { ...local, ...incoming, priceHistory: priced.priceHistory || local.priceHistory, priceChange: priced.priceChange || null };
  }

  async function applyLocally(changes) {
    const { items: itemChanges, favorites: favChanges, carts: cartChanges, settings: settingsValue } = changes;
    if (Object.keys(itemChanges).length) {
      await store.updateItems((items) => {
        const next = { ...items };
        for (const [id, packed] of Object.entries(itemChanges)) {
          if (packed === null) delete next[id];
          // What only this browser knows (pictures, trend, last attempt…) stays;
          // a price seen elsewhere goes into this browser's price history too.
          else next[id] = withPriceFrom(next[id], unpack(packed, ITEM_FIELDS));
        }
        return next;
      });
    }
    if (Object.keys(favChanges).length) {
      await store.updateFavorites((favorites) => {
        const next = { ...favorites };
        for (const [id, packed] of Object.entries(favChanges)) {
          if (packed === null) delete next[id];
          else next[id] = { ...withPriceFrom(next[id], unpack(packed, FAVORITE_FIELDS)), lastSeenAt: (next[id] && next[id].lastSeenAt) || Date.now() };
        }
        return next;
      });
    }
    if (Object.keys(cartChanges).length) {
      await store.updateCarts((carts) => {
        const byId = new Map(carts.map((cart) => [cart.id, cart]));
        for (const [id, value] of Object.entries(cartChanges)) {
          if (value === null) byId.delete(id);
          else {
            byId.set(id, {
              id,
              name: value.n,
              game: value.g || null,
              createdAt: value.ca,
              ...(value.ua ? { updatedAt: value.ua } : {}),
              items: (value.it || []).map((packed) => unpack(packed, LIST_ITEM_FIELDS)),
            });
          }
        }
        return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      });
    }
    if (settingsValue) {
      await chrome.storage.local.get(store.KEYS.settings).then(async (got) => {
        const current = got[store.KEYS.settings] || {};
        const mine = Object.fromEntries(Object.entries(current).filter(([key]) => LOCAL_SETTINGS.has(key)));
        // An older version synced every setting: never take another browser's key.
        const theirs = Object.fromEntries(Object.entries(settingsValue).filter(([key]) => !LOCAL_SETTINGS.has(key)));
        await chrome.storage.local.set({ [store.KEYS.settings]: { ...theirs, ...mine } });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // One round
  // ---------------------------------------------------------------------------

  async function getState() {
    return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || { base: {}, at: 0 };
  }

  /**
   * Bring this browser and the synced copy together. Resolves to the status
   * (also kept in cmcs.sync for the settings page).
   */
  async function mergeOnce() {
    const settings = await store.getSettings();
    if (!settings.cloudSync || !chrome.storage.sync) return null;
    const [items, favorites, carts, state, all] = await Promise.all([
      store.getItems(),
      store.getFavorites(),
      store.getCarts(),
      getState(),
      chrome.storage.sync.get(null),
    ]);
    const local = localRecords({ items, favorites, carts, settings });
    const remote = remoteRecords(all);
    const now = Date.now();
    // What was agreed only counts for the copy it was agreed with: the same
    // id, with this browser's last write still in it. Or the copy "Delete
    // everything" made of it, when this browser sent nothing new since that
    // wipe (what it saved after, say with Chrome sync off, is not wiped).
    // Any other copy: join, remove nothing.
    const epoch = all && all[EPOCH_KEY] && typeof all[EPOCH_KEY].id === 'string' ? all[EPOCH_KEY] : null;
    const ownMark = state.id && all ? all[`${MARK_PREFIX}${state.id}`] : null;
    const sameCopy = Boolean(epoch && state.epoch && state.w && ownMark) && epoch.id === state.epoch && ownMark.n === state.w;
    const wipedOurs =
      Boolean(epoch && state.epoch) && epoch.id !== state.epoch && Array.isArray(epoch.prev) && epoch.prev.includes(state.epoch) && !(state.dataAt > (epoch.at || 0));
    const trusted = sameCopy || wipedOurs;
    const base = trusted ? { ...state.base } : {};
    // After a join this browser goes on under a new name: a copy of this
    // profile elsewhere (a restored backup, a moved profile) then has its own.
    const installId = trusted && state.id ? state.id : newId();
    const markKey = `${MARK_PREFIX}${installId}`;
    const epochId = epoch ? epoch.id : newId();

    const toLocal = { items: {}, favorites: {}, carts: {}, settings: null };
    const take = (key, value) => {
      const [kind, id] = [key.slice(0, 1), key.slice(2)];
      if (kind === 'i') toLocal.items[id] = value;
      else if (kind === 'f') toLocal.favorites[id] = value;
      else if (kind === 'l') toLocal.carts[id] = value;
      else if (key === 's' && value) toLocal.settings = value;
    };
    const pushes = [];
    const removals = [];

    const keys = new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
    for (const key of keys) {
      const mine = local.get(key);
      const theirs = remote.get(key);
      const agreed = base[key];
      if (theirs && theirs.incomplete) continue;
      const mineHash = mine && hash(mine.json);
      const theirHash = theirs && hash(theirs.json);
      if (mine && theirs) {
        if (mineHash === theirHash) base[key] = mineHash;
        else {
          const changedHere = mineHash !== agreed;
          const changedThere = theirHash !== agreed;
          if (changedThere && (!changedHere || theirs.u > (state.at || 0))) {
            take(key, theirs.value);
            base[key] = theirHash;
          } else pushes.push({ key, record: mine, existing: true });
        }
      } else if (mine) {
        // Gone there: removed elsewhere, unless it changed here since (then it goes back).
        if (agreed && mineHash === agreed) {
          if (key !== 's') take(key, null);
          delete base[key];
        } else pushes.push({ key, record: mine, existing: false });
      } else if (theirs) {
        if (agreed && theirHash === agreed) {
          removals.push(key);
          delete base[key];
        } else {
          take(key, theirs.value);
          base[key] = theirHash;
        }
      } else delete base[key];
    }

    // What fits: what is already synced keeps its place; new records by importance.
    const kept = Object.entries(all || {}).filter(([key]) => !removals.some((r) => key === r || key.startsWith(`${r}~`)));
    let bytes = kept.reduce((sum, [key, value]) => sum + bytesOf(key) + bytesOf(JSON.stringify(value)), 0);
    let count = kept.filter(([key]) => !key.includes('~') && !key.startsWith('_')).length;
    const toSet = {};
    if (!epoch) {
      toSet[EPOCH_KEY] = { id: epochId, at: now };
      bytes += sizeOf({ [EPOCH_KEY]: toSet[EPOCH_KEY] });
    }
    let skipped = 0;
    pushes.sort((a, b) => a.record.priority - b.record.priority || b.record.recent - a.record.recent);
    for (const { key, record, existing } of pushes) {
      const entries = entriesFor(key, record, now);
      const old = existing ? sizeOf(Object.fromEntries(Object.entries(all).filter(([k]) => k === key || k.startsWith(`${key}~`)))) : 0;
      const grow = sizeOf(entries) - old;
      if (bytes + grow > BUDGET_BYTES || (!existing && count + 1 > MAX_RECORDS)) {
        skipped += 1;
        continue;
      }
      bytes += grow;
      if (!existing) count += 1;
      Object.assign(toSet, entries);
      base[key] = hash(record.json);
      // Parts a shorter version no longer needs.
      for (const k of Object.keys(all)) if (k.startsWith(`${key}~`) && !(k in entries)) removals.push(k);
    }
    const removeKeys = [...new Set(removals.flatMap((key) => [key, ...Object.keys(all).filter((k) => k.startsWith(`${key}~`))]))];

    // Every write leaves this browser's mark; after a join it is written in
    // any case, so the next round knows the copy again; and once a month, so
    // a browser that only takes changes is not cleared away as gone.
    const sentData = Object.keys(toSet).some((key) => !key.startsWith('_')) || removeKeys.some((key) => !key.startsWith('_'));
    const renew = !sameCopy || !(ownMark && ownMark.at > now - MARK_RENEW_MS);
    let writeMark = state.w || null;
    if (Object.keys(toSet).length || removeKeys.length || renew) {
      writeMark = newId();
      toSet[markKey] = { n: writeMark, at: now };
      bytes += sizeOf({ [markKey]: toSet[markKey] });
      for (const [key, value] of Object.entries(all || {})) {
        if (key.startsWith(MARK_PREFIX) && key !== markKey && !(value && value.at > now - MARK_KEEP_MS)) removeKeys.push(key);
      }
    }

    let error = null;
    try {
      await applyLocally(toLocal);
      if (removeKeys.length) await chrome.storage.sync.remove(removeKeys);
      if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    const status = {
      at: now,
      error,
      sent: Object.keys(toSet).filter((key) => !key.includes('~') && !key.startsWith('_')).length,
      received:
        Object.keys(toLocal.items).length + Object.keys(toLocal.favorites).length + Object.keys(toLocal.carts).length + (toLocal.settings ? 1 : 0),
      removed: removeKeys.filter((key) => !key.includes('~') && !key.startsWith('_')).length,
      skipped,
      bytes: Math.max(0, bytes),
      records: count,
    };
    // When another browser last brought something (the settings page shows it: "never" points at a setup problem).
    status.lastReceivedAt = !error && status.received ? now : (state.status && state.status.lastReceivedAt) || null;
    // A failed write is tried again next round: only what went through counts as agreed.
    await chrome.storage.local.set({
      [STATE_KEY]: error
        ? { ...state, status }
        : { id: installId, base, at: now, epoch: epochId, w: writeMark, dataAt: sentData ? now : state.dataAt || 0, status },
    });
    return status;
  }

  function newId() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  let running = null;
  let again = false;
  /** One round at a time; a change during a round asks for one more. */
  function merge() {
    if (running) {
      again = true;
      return running;
    }
    running = mergeOnce()
      .catch((err) => ({ error: String(err && err.message) }))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          mergeSoon(1000);
        }
      });
    return running;
  }

  let timer = null;
  /** After a change: one round a little later, so a burst of changes is one write. */
  function mergeSoon(delayMs = 10000) {
    clearTimeout(timer);
    timer = setTimeout(merge, delayMs);
  }

  root.CMCS.sync = { merge, mergeSoon, pack, unpack, localRecords, remoteRecords, entriesFor, bytesOf, ITEM_FIELDS, FAVORITE_FIELDS, STATE_KEY, EPOCH_KEY };
})(globalThis);
