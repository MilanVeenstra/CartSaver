/*
 * The texts: Dutch and English have the same keys and the same $1…$9, and every
 * key the code asks for exists. A missing key shows up as its name ("refillButton")
 * in the interface, so this catches it before anyone sees it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const nl = JSON.parse(read('_locales/nl/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));

function filesIn(dir, ext) {
  return fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
}
const sources = filesIn('src', '.js').map((file) => ({ file, text: read(file) }));
const pages = filesIn('src', '.html').map((file) => ({ file, text: read(file) }));
const placeholders = (message) => [...message.matchAll(/\$([1-9])/g)].map((m) => m[1]).sort().join(',');

describe('texts in Dutch and English', () => {
  it('have the same keys', () => {
    assert.deepEqual(Object.keys(nl).sort(), Object.keys(en).sort());
  });

  it('fill the same $1…$9', () => {
    const different = Object.keys(nl).filter((key) => en[key] && placeholders(nl[key].message) !== placeholders(en[key].message));
    assert.deepEqual(different, []);
  });

  it('are never empty, and the Dutch ones are Dutch', () => {
    const empty = Object.keys(nl).filter((key) => !nl[key].message.trim() || !en[key].message.trim());
    assert.deepEqual(empty, []);
    // A text left untranslated is the same in both (names and short labels may be).
    const words = (message) => (message.match(/\p{L}{2,}/gu) || []).length;
    const NAMES = new Set(['extName']);
    const same = Object.keys(nl).filter((key) => !NAMES.has(key) && nl[key].message === en[key].message && words(nl[key].message) > 3);
    assert.deepEqual(same, []);
  });

  it('exist for every key the code asks for', () => {
    const missing = new Set();
    const need = (key, file) => {
      if (!nl[key] || !en[key]) missing.add(`${key} (${file})`);
    };
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) need(m[1], file);
      for (const m of text.matchAll(/\bt\([^()',]*\?\s*'([A-Za-z0-9_]+)'\s*:\s*'([A-Za-z0-9_]+)'/g)) {
        need(m[1], file);
        need(m[2], file);
      }
      // tn() picks `<key>One` for one: both must be there.
      for (const m of text.matchAll(/\btn\(\s*'([A-Za-z0-9_]+)'/g)) {
        need(m[1], file);
        need(`${m[1]}One`, file);
      }
    }
    for (const { file, text } of pages) {
      for (const m of text.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([A-Za-z0-9_]+)"/g)) need(m[1], file);
    }
    const manifest = read('manifest.json');
    for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) need(m[1], 'manifest.json');
    assert.deepEqual([...missing], []);
  });

  it('fit the Chrome Web Store: name ≤ 75 and description ≤ 132 characters', () => {
    for (const messages of [nl, en]) {
      assert.ok(messages.extName.message.length <= 75, messages.extName.message);
      assert.ok(messages.extDescription.message.length <= 132, messages.extDescription.message);
    }
  });
});
