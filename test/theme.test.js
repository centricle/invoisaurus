import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';

/**
 * Semantic-token guard.
 *
 * Light and dark mode both work off tokens -- paper, plate, ink, rule, muted,
 * faint, accent, on-accent, ok, warn, danger -- each a `light-dark()` pair
 * declared once in public/css/app.css's `@theme` block. A view picks a role,
 * and the token carries both themes.
 *
 * Nothing in the build stops a template from using a Tailwind palette
 * utility. app.css keeps Tailwind's default palette, and has to, because hosts
 * import this file. A template could therefore use `bg-indigo-700`, which
 * compiles to one fixed color that does not change with the theme. This test
 * is what prevents that: it fails if any view, script or top-level src/*.js
 * file contains a palette utility. It also checks that every token app.css
 * declares is a `light-dark()` pair, because a single physical value would
 * look the same in both themes.
 */

const root = import.meta.dirname;
const SRC_VIEWS = path.join(root, '..', 'src', 'views');
const PUBLIC_JS = path.join(root, '..', 'public', 'js');
const SRC_DIR = path.join(root, '..', 'src');
const APP_CSS = path.join(root, '..', 'public', 'css', 'app.css');

function walk(dir, ext) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Every file this guard scans, read individually so a failure can name one. */
function sourceFiles() {
  return [
    ...walk(SRC_VIEWS, '.ejs'),
    ...fs.readdirSync(PUBLIC_JS).filter((f) => f.endsWith('.js')).map((f) => path.join(PUBLIC_JS, f)),
    ...fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(SRC_DIR, f)),
  ];
}

// Variant prefixes a color utility may carry, utility prefixes that take a
// color, and the Tailwind palettes themselves. A view may not combine these
// into a fixed color; the semantic tokens cover every case a view needs.
const VARIANTS = 'hover:|focus:|disabled:|placeholder:|group-hover:|focus-visible:';
const UTILITIES = 'bg|text|border|ring|divide|outline|placeholder|fill|stroke|from|to|via|decoration|caret|accent|shadow';
const PALETTES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

const PALETTE_UTILITY = new RegExp(
  `\\b(?:${VARIANTS})?(?:${UTILITIES})-(?:${PALETTES})-\\d+`,
  'g',
);

const FIXED_COLOR = /\b(?:bg|text)-(?:white|black)\b/g;

test('views, public/js and top-level src/*.js use only semantic color utilities', () => {
  const failures = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(root, '..'), file);
    for (const match of text.matchAll(PALETTE_UTILITY)) {
      failures.push(`${rel}: ${match[0]}`);
    }
    for (const match of text.matchAll(FIXED_COLOR)) {
      failures.push(`${rel}: ${match[0]}`);
    }
  }

  assert.deepEqual(
    failures,
    [],
    `found Tailwind palette or fixed-color utilities outside the token set:\n${failures.join('\n')}\n`
      + 'Reach for a semantic token (bg-paper, text-ink, border-rule, text-accent, '
      + 'text-warn, and the rest declared in public/css/app.css) instead.',
  );
});

test('every semantic color token in app.css is a light-dark() pair', () => {
  const css = fs.readFileSync(APP_CSS, 'utf8');
  const declarations = [...css.matchAll(/^\s*(--color-[\w-]+):\s*(.+?);/gm)];

  // If the @theme block were emptied, or the declaration syntax changed
  // enough that this regex stopped matching, the check below would have
  // nothing to examine and would pass. This assertion fails first in that case.
  assert.ok(declarations.length >= 8, `expected at least 8 --color-* declarations, found ${declarations.length}`);

  const singleValued = declarations
    .filter(([, name, value]) => !value.includes('light-dark('))
    .map(([, name]) => name);

  assert.deepEqual(
    singleValued,
    [],
    `these tokens have no light-dark() pair, so they read the same color in both themes: ${singleValued.join(', ')}`,
  );
});

test('at least 8 distinct semantic color utilities are used across the views', () => {
  const TOKENS = 'paper|plate|ink|rule|muted|faint|accent|on-accent|ok|warn|danger';
  const SEMANTIC_UTILITY = new RegExp(
    `\\b(?:${VARIANTS})?(?:${UTILITIES})-(?:${TOKENS})(?:/\\d+)?\\b`,
    'g',
  );

  const found = new Set();
  for (const file of walk(SRC_VIEWS, '.ejs')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(SEMANTIC_UTILITY)) found.add(match[0].replace(/^(?:hover:|focus:|disabled:|placeholder:|group-hover:|focus-visible:)/, ''));
  }

  // A regex out of sync with the token names would find nothing and pass
  // vacuously, so this asserts that it finds something.
  assert.ok(found.size >= 8, `expected at least 8 distinct semantic color utilities, found ${found.size}: ${[...found].join(', ')}`);
});
