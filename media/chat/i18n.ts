/**
 * Webview localization.
 *
 * The webview is a sandboxed browser bundle, so it cannot use `src/core/I18n` (which
 * imports `vscode`). It reads the catalog for the language the host wrote into
 * `<html lang="…">`, using the shared catalogs module.
 */
import { resolveLocale, translate } from '../../src/core/catalogs';

const LOCALE = resolveLocale(
  typeof document !== 'undefined' ? document.documentElement.lang : 'en',
);

/** `l10n(key, ...args)` — look up a message id in the active catalog. */
export function l10n(key: string, ...args: Array<string | number>): string {
  return translate(LOCALE, key, args);
}
