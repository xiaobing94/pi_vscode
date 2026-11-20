/**
 * Localization guardrails.
 *
 * Copy lives in `l10n/*.json` only. These tests fail when a catalog is incomplete,
 * when a key goes missing, or when a string is hardcoded back into the source —
 * which is exactly what makes adding a language (or fixing a typo) safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { test, assert } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const l10nDir = path.join(root, 'l10n');

const read = (locale) => JSON.parse(fs.readFileSync(path.join(l10nDir, `${locale}.json`), 'utf8'));
const en = read('en');
const zh = read('zh-cn');

const placeholders = (text) => [...String(text).matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();
const CJK = /[\u4e00-\u9fff]/;

test('every catalog ships the same keys, in a stable order', () => {
  const enKeys = Object.keys(en);
  assert.deepEqual(Object.keys(zh), enKeys, 'zh-cn must have exactly the en keys');
  assert.deepEqual(enKeys, [...enKeys].sort(), 'keys are sorted, so diffs stay readable');
  assert.ok(enKeys.length > 300, `expected a full catalog, got ${enKeys.length} keys`);
});

test('keys are readable ids and every string is translated', () => {
  for (const [key, text] of Object.entries(en)) {
    assert.match(key, /^[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/, `${key} is a namespaced camelCase id`);
    assert.equal(typeof text, 'string', `${key} must be a string`);
    assert.ok(text.trim().length > 0, `${key} must not be empty`);
  }
  for (const [key, text] of Object.entries(zh)) {
    assert.ok(text.trim().length > 0, `${key} must be translated`);
    assert.notEqual(text, en[key], `${key} must be translated, not copied`);
  }
});

test('placeholders match between languages', () => {
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} placeholder mismatch`);
  }
});

test('the English catalog contains no leftover Chinese copy', () => {
  const dirty = Object.entries(en).filter(([, text]) => CJK.test(text)).map(([key]) => key);
  assert.deepEqual(dirty, [], 'English strings must not contain CJK characters');
});

/** Files that may legitimately contain CJK: comments, docs and test data. */
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'test', '.pi-vscode-test'].includes(entry.name)) continue;
      sourceFiles(p, out);
    } else if (/\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('code contains no hardcoded copy: all user-facing text goes through l10n()', () => {
  const offenders = [];
  for (const file of [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'media')), ...sourceFiles(path.join(root, 'pi-extensions'))]) {
    const source = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    (function visit(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const text = node.getText(sf);
        if (CJK.test(text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          offenders.push(`${path.relative(root, file)}:${line + 1} ${text.slice(0, 60).replace(/\n/g, '\\n')}`);
        }
        return;
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  assert.deepEqual(offenders, [], 'use l10n() message ids instead of inline copy');
});

test('l10n() calls only use keys that exist in the catalog', async () => {
  const { CATALOGS, translate, ALL_KEYS } = await import(pathToFileURL(path.join(root, 'dist', 'i18n-check.js')).href);
  const used = new Set();
  for (const file of [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'media')), ...sourceFiles(path.join(root, 'pi-extensions'))]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/l10n\(\s*'([^']+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 250, `expected many l10n() call sites, found ${used.size}`);
  const unknown = [...used].filter((key) => !(key in CATALOGS.en));
  assert.deepEqual(unknown, [], 'every l10n() key must exist in l10n/en.json');

  // Keys nothing references are dead weight (or a rename that was not applied).
  const unused = ALL_KEYS.filter((key) => !used.has(key) && !['info.current'].includes(key));
  assert.deepEqual(unused, [], 'catalog keys must be referenced by the code');

  assert.equal(translate('en', 'sessionTree.newSession'), en['sessionTree.newSession']);
  assert.equal(translate('zh-cn', 'sessionTree.newSession'), zh['sessionTree.newSession']);
  // Unknown locales fall back to English rather than rendering raw keys.
  assert.equal(translate('fr', 'sessionTree.newSession'), en['sessionTree.newSession']);
});

test('an unsupported locale still resolves to a shipped catalog', async () => {
  const { resolveLocale } = await import(pathToFileURL(path.join(root, 'dist', 'i18n-check.js')).href);
  assert.equal(resolveLocale('zh-cn'), 'zh-cn');
  assert.equal(resolveLocale('zh-Hans'), 'zh-cn');
  assert.equal(resolveLocale('zh-tw'), 'zh-cn');
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('de'), 'en');
  assert.equal(resolveLocale(undefined), 'en');
});
