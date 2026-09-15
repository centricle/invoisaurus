import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';

/**
 * Palette coverage for light mode.
 *
 * Light mode works by redefining Tailwind's color variables in
 * public/css/app.css, not by renaming classes in the templates -- so
 * `bg-slate-950` means "page ground" and which physical color that is
 * depends on `--color-slate-950`, redefined there with `light-dark()`. The
 * saving is that a template never has to know the theme exists. The cost is
 * the same shortcut in reverse: a color class reached for in a template
 * later has no light value unless someone adds one to app.css, and nothing
 * stops it from shipping that way -- it will render its dark-tuned color on
 * a light page, correctly as far as the browser is concerned, with nothing
 * on screen to say it is wrong. This file is the flag that catches that gap
 * before a reader does.
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

function sourceText() {
  const files = [
    ...walk(SRC_VIEWS, '.ejs'),
    ...fs.readdirSync(PUBLIC_JS).filter((f) => f.endsWith('.js')).map((f) => path.join(PUBLIC_JS, f)),
    ...fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(SRC_DIR, f)),
  ];
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

// Variant prefixes a color utility may carry, utility prefixes that take a
// palette color, the Tailwind palettes themselves, and the fixed shade steps
// -- in that order, matching how the class name is actually built.
const VARIANTS = 'hover:|focus:|disabled:|placeholder:|group-hover:';
const UTILITIES = 'bg|text|border|ring|divide|outline|placeholder|fill|stroke|from|to|via|decoration|caret|accent|shadow';
const PALETTES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const SHADES = '50|100|200|300|400|500|600|700|800|900|950';

const COLOR_UTILITY = new RegExp(
  `\\b(?:${VARIANTS})?(?:${UTILITIES})-(${PALETTES})-(${SHADES})(?:/\\d+)?\\b`,
  'g',
);

/** Every distinct `palette-shade` combination used anywhere in the sources. */
function paletteShades(text) {
  const found = new Set();
  for (const match of text.matchAll(COLOR_UTILITY)) found.add(`${match[1]}-${match[2]}`);
  return found;
}

// Chosen to read correctly against either page ground already, so redefining
// them would just make the primary button change color with the theme, for
// no benefit. See the header comment in public/css/app.css, which names the
// same two shades for the same reason.
const FIXED_SHADES = new Set(['sky-500', 'sky-600']);

test('every color class in the app has a light value in app.css, or is deliberately fixed', () => {
  const found = paletteShades(sourceText());

  // If the regex stopped matching -- a prefix list edited out of sync with
  // this file, a class-naming convention that changed -- the loop below would
  // have nothing to check and the test would pass for having found no bugs to
  // find. This keeps that failure mode loud instead of silent.
  assert.ok(found.size >= 20, `expected at least 20 distinct palette-shades, found ${found.size}`);

  const css = fs.readFileSync(APP_CSS, 'utf8');
  const missing = [];
  for (const shade of found) {
    if (FIXED_SHADES.has(shade)) continue;
    // Shade 500 sits at the middle of every Tailwind scale. app.css's mirror
    // rule maps a flipped shade `n` to the default value of `1000 - n`, and
    // 500 maps to itself -- so a light-dark() line is a no-op unless the
    // shade is deliberately adjusted, as slate-500 is (see app.css). This
    // test does not require a line either way; it only checks the shades
    // that do carry one aren't missing. FIXED_SHADES is the other kind of
    // exemption: a design choice to keep a color the same in both themes,
    // not an artifact of the mirror math.
    if (shade.endsWith('-500')) continue;

    const [palette, step] = shade.split('-');
    const line = new RegExp(`--color-${palette}-${step}:\\s*light-dark\\(`);
    if (!line.test(css)) missing.push(shade);
  }

  assert.deepEqual(
    missing,
    [],
    `app.css has no light-dark() line for: ${missing.join(', ')}. `
      + 'Add a --color-<palette>-<shade>: light-dark(<light>, <dark>) line to the '
      + '@theme block in public/css/app.css, or add the shade to FIXED_SHADES here '
      + 'if it is meant to read the same in both themes.',
  );
});

test('bg-black and text-black do not appear in the app', () => {
  // black and white are not part of the Tailwind palette scale the regex
  // above scans, so they get no light-dark() mirror automatically. white is
  // already in use on primary buttons and reads correctly on both grounds by
  // design, sharing the reasoning that exempts sky-500/sky-600. black has no
  // such review yet -- its first use needs a deliberate light-dark() decision
  // rather than silently painting a black box on a light page.
  const text = sourceText();
  assert.ok(!/\bbg-black\b/.test(text), 'bg-black found: give it a light value or a deliberate exemption first');
  assert.ok(!/\btext-black\b/.test(text), 'text-black found: give it a light value or a deliberate exemption first');
});
