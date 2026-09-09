import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { parseCents, parseQuantity, lineAmountCents } from '../src/money.js';

/**
 * The browser's copy of the money arithmetic must agree with the server's.
 *
 * public/js/invoice-editor.js reimplements parseScaled and roundHalfUp because
 * it cannot import an ES module from src/ without a bundler, and the file says
 * so at the top: "A running total that disagrees with the server by a penny is
 * worse than no running total at all." Nothing enforced it. The `-.` bug landed
 * in both copies and would have been fixed in one.
 *
 * The two functions are lifted out of the IIFE by source text rather than
 * imported, since the file exports nothing and runs against `document` on load.
 * The anchors below are the lines that bracket them; if either moves, this
 * fails loudly rather than quietly testing nothing.
 */
const EDITOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'invoice-editor.js',
);

function editorParser() {
  const source = fs.readFileSync(EDITOR, 'utf8');
  const start = source.indexOf('const roundHalfUp');
  const end = source.indexOf('const usd = new Intl');
  assert.ok(start !== -1 && end > start, 'the arithmetic block moved; update the anchors');

  const body = source.slice(start, end);
  assert.match(body, /function parseScaled/, 'parseScaled is no longer in the extracted block');

  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { parseScaled, roundHalfUp };`)();
}

test('the browser parses money exactly as the server does', () => {
  const { parseScaled } = editorParser();

  const inputs = [
    '150', '150.00', '$1,500.50', ' 0.07 ', '-25.00', '0', '0.00', '0.005', '0.004',
    '', '   ', 'abc', '.', '-', '-.', '..', '-.-', '$', '.5', '-.5', '5.', '-5.',
    '9999', '12.5', '99.99', '1,234,567.89', '-0.005',
  ];

  for (const input of inputs) {
    assert.equal(parseScaled(input, 100), parseCents(input), `cents: ${JSON.stringify(input)}`);
    assert.equal(parseScaled(input, 1000), parseQuantity(input), `milli: ${JSON.stringify(input)}`);
  }

  // null and undefined reach the browser copy through an input's `.value`, so
  // they are covered here too even though a real field always yields a string.
  assert.equal(parseScaled(null, 100), parseCents(null));
  assert.equal(parseScaled(undefined, 100), parseCents(undefined));
});

test('the browser computes a line amount exactly as the server does', () => {
  const { parseScaled, roundHalfUp } = editorParser();
  const editorAmount = (q, r) => {
    const quantity = parseScaled(q, 1000);
    const rate = parseScaled(r, 100);
    return quantity == null || rate == null ? 0 : roundHalfUp((quantity * rate) / 1000);
  };

  for (const [q, r] of [
    ['0.1', '150'], ['12.5', '150'], ['3', '99.99'], ['-0.5', '0.05'],
    ['2', '-150.00'], ['0.1', '0.10'], ['1', ''], ['', '150'], ['0', '150'],
  ]) {
    const server = lineAmountCents(parseQuantity(q), parseCents(r));
    assert.equal(editorAmount(q, r), server, `${q} x ${r}`);
  }
});
