import * as vscode from 'vscode';
import { resolveLocale, translate, type Locale } from './catalogs';

/**
 * Extension-host localization.
 *
 * Every user-facing string is a message id resolved against `l10n/<locale>.json`
 * (see `catalogs.ts`); contributed manifest keys are localized through
 * `package.nls*.json`, which uses the same locale resolution.
 */
export const LOCALE: Locale = resolveLocale((vscode as any)?.env?.language ?? process.env.PI_VSCODE_LOCALE);
export const IS_ZH = LOCALE === 'zh-cn';

/** `l10n(key, ...args)` — look up a message id in the active catalog. */
export function l10n(key: string, ...args: Array<string | number>): string {
  return translate(LOCALE, key, args);
}

/** BCP-47 tag for webview `<html lang>`. */
export function lang(): string {
  return LOCALE === 'zh-cn' ? 'zh-CN' : 'en';
}

/** Locale-aware date/time for tree tooltips and cards. */
export function dateTime(value: string | number | Date): string {
  try {
    return new Date(value).toLocaleString(IS_ZH ? 'zh-CN' : 'en-US');
  } catch {
    return String(value);
  }
}
