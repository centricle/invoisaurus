import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { fontBytes, embedBundled, configureFonts, MONO_REGULAR, MONO_MEDIUM } from '../src/lib/pdf/fonts.js';
import { sanitize } from '../src/lib/pdf/layout.js';

/**
 * What the embedded faces have to be able to draw.
 *
 * Everything that reaches a page has been through `sanitize`, so the answer is
 * exactly the set `sanitize` can emit -- swept out of it rather than written
 * down, because a list typed by hand is a list that drifts from the function
 * it is supposed to describe.
 */
const printable = (() => {
  const set = new Set();
  for (let cp = 0x20; cp <= 0xFFFF; cp += 1) {
    for (const char of sanitize(String.fromCodePoint(cp))) {
      if (char !== '\n' && char !== '\t') set.add(char);
    }
  }
  return [...set].sort();
})();

test('the characters an invoice can print are a fixed, known set', () => {
  // Pinned so a change to sanitize that *narrows* what it emits shows up here
  // rather than silently making the coverage test below easier to pass.
  assert.equal(printable.length, 208);
  for (const char of ['$', '.', ',', '-', 'é', '&', "'", '"', '€']) {
    assert.ok(printable.includes(char), `sanitize can no longer emit ${char}`);
  }
});

test('every bundled face has a glyph for every character sanitize can emit', () => {
  // This is the test the Modern style exists behind.
  //
  // A standard font throws when asked to draw something it cannot encode --
  // that is why sanitize was written, and why an emoji in a description is a
  // dropped character rather than a 500. An embedded TrueType face does not
  // throw. pdf-lib encodes .notdef and draws a blank box at the right advance
  // width, so a name with the wrong character in it reaches the client looking
  // like a name with a hole in it, and nothing anywhere reports a problem.
  //
  // Subsetting these faces more tightly than WinAnsi is what would cause that.
  // An earlier pass cut them to the characters a sample invoice happened to
  // use: 15 KB instead of 33, and missing 132 of the 208 below -- the
  // apostrophe, both quote marks, and every accented letter among them.
  for (const file of [MONO_REGULAR, MONO_MEDIUM]) {
    const font = fontkit.create(fontBytes(file));
    const missing = printable.filter((char) => !font.hasGlyphForCodePoint(char.codePointAt(0)));
    assert.deepEqual(missing, [], `${file} (${font.postscriptName}) cannot draw ${missing.join('')}`);
  }
});

test('a missing glyph is silent in an embedded face and loud in a standard one', () => {
  // The asymmetry the test above guards against, stated as a fact so it does
  // not have to be rediscovered. If this ever starts failing on the embedded
  // side, pdf-lib has begun reporting the problem itself and the coverage test
  // is no longer the only thing standing between a bad character and a client.
  return PDFDocument.create().then(async (doc) => {
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const mono = await embedBundled(doc, MONO_REGULAR);

    assert.throws(() => helvetica.encodeText('🚀'), 'a standard font refuses what it cannot encode');
    assert.doesNotThrow(() => mono.encodeText('🚀'), 'an embedded face quietly encodes .notdef');
  });
});

test('a bundled face embeds subset, not whole', async () => {
  // Two weights embedded in full would put roughly half a megabyte on a
  // document whose entire job is to be emailed.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const mono = await embedBundled(doc, MONO_REGULAR);
  page.drawText('$1,445.00', { x: 54, y: 700, size: 10, font: mono });

  const bytes = await doc.save();
  assert.ok(bytes.length < 40_000, `expected a subset, got ${bytes.length} bytes`);
});

test('a host can supply the faces from somewhere other than this package', () => {
  // The only filesystem read in the PDF code, swapped for a loader that knows
  // nothing about a directory. What comes back must be the bytes it returned,
  // and restoring the default must forget them.
  const fromPackage = fontBytes(MONO_REGULAR);
  const requested = [];
  try {
    configureFonts({ load: (file) => { requested.push(file); return fromPackage.subarray(0, 16); } });
    assert.equal(fontBytes(MONO_REGULAR).length, 16, 'bytes come from the loader');
    assert.equal(fontBytes(MONO_REGULAR).length, 16, 'and are cached');
    assert.deepEqual(requested, [MONO_REGULAR], 'the loader was asked once, by file name');
  } finally {
    configureFonts();
  }
  assert.equal(fontBytes(MONO_REGULAR).length, fromPackage.length, 'the default is back and the cache is fresh');
  assert.throws(() => configureFonts({ load: 'nope' }), TypeError);
});

test('a face that cannot be found fails on the PDF, not on startup', () => {
  // Lazy on purpose: a missing file should fail the one route that needs it,
  // with a message that names the fix, and leave every other page working.
  try {
    configureFonts({ load: (file) => { throw new Error(`no ${file} here`); } });
    assert.throws(() => fontBytes(MONO_MEDIUM), /no IBMPlexMono-Medium.ttf here/);
  } finally {
    configureFonts();
  }
});
