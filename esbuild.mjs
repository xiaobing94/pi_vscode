import { build, context } from 'esbuild';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2022',
};

mkdirSync('dist', { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  banner: { js: '/* Pi for VS Code — bundled by esbuild. */' },
};

/** @type {import('esbuild').BuildOptions} */
const chat = {
  ...shared,
  entryPoints: ['media/chat/main.ts'],
  outfile: 'dist/chat.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

// Test harness: expose internal services for integration tests (no vscode APIs at import time are executed).
/** @type {import('esbuild').BuildOptions} */
const testBundle = {
  ...shared,
  entryPoints: ['src/testable.ts'],
  outfile: 'dist/testable.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
};

/** Localization runtime only: lets tests check catalogs without the VS Code API. */
/** @type {import('esbuild').BuildOptions} */
const i18nCheck = {
  ...shared,
  entryPoints: ['src/i18nCheck.ts'],
  outfile: 'dist/i18n-check.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
};

if (watch) {
  const [a, b, c, d] = await Promise.all([context(extension), context(chat), context(testBundle), context(i18nCheck)]);
  await Promise.all([a.watch(), b.watch(), c.watch(), d.watch()]);
  console.log('watching...');
} else {
  await Promise.all([build(extension), build(chat), build(testBundle), build(i18nCheck)]);
}
