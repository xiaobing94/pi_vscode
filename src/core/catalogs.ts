/**
 * Message catalogs — the source of truth for every user-facing string.
 *
 * `l10n/en.json` is canonical: keys are stable, human-readable ids and the code never
 * contains copy, so a translation can be edited without touching TypeScript. Adding a
 * language means adding `l10n/<locale>.json` and listing it in {@link CATALOGS}.
 *
 * Keep this module dependency-free: the webview bundle imports it as well.
 */
import en from '../../l10n/en.json';
import zhCn from '../../l10n/zh-cn.json';

export type Locale = 'en' | 'zh-cn';

/** Every catalog that ships with the extension. */
export const CATALOGS: Record<Locale, Record<string, string>> = { en, 'zh-cn': zhCn };

/** Languages a contributed manifest key (`package.nls.<locale>.json`) exists for. */
export const NLS_LOCALES: Locale[] = ['en', 'zh-cn'];

/**
 * Resolve a VS Code locale tag to a shipped catalog.
 * `zh-hans`, `zh-CN`, `zh` all map to `zh-cn`; anything unknown falls back to English.
 */
export function resolveLocale(tag: string | undefined): Locale {
  const value = String(tag ?? '').toLowerCase();
  if (value.startsWith('zh')) return 'zh-cn';
  return 'en';
}

/** `{0}`, `{1}`, … positional interpolation. */
export function format(template: string, args: Array<string | number>): string {
  if (!args.length) return template;
  return template.replace(/\{(\d+)\}/g, (full, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : full);
}

/**
 * Look up `key` in the active catalog.
 *
 * A missing key is a programming error, not a runtime condition: it is reported once
 * per key and rendered as the key itself so the gap is obvious in the UI and in tests.
 */
export function translate(locale: Locale, key: string, args: Array<string | number> = []): string {
  const table = CATALOGS[locale] ?? CATALOGS.en;
  const template = table[key] ?? CATALOGS.en[key];
  if (template === undefined) {
    reportMissing(key);
    return key;
  }
  return format(template, args);
}

const missing = new Set<string>();

function reportMissing(key: string): void {
  if (missing.has(key)) return;
  missing.add(key);
  console.warn(`[pi] missing l10n key: ${key}`);
}

/** Keys reported as missing so far (used by the l10n test). */
export function missingKeys(): string[] {
  return [...missing];
}

export const ALL_KEYS = Object.keys(en).sort();
