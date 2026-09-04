import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import {
  parseCents, parseQuantity, lineAmountCents, formatUSD, formatQuantity, sumCents,
  quantityInputValue, centsInputValue,
} from '../src/money.js';

test('parseCents accepts the shapes a human types', () => {
  assert.equal(parseCents('150'), 15000);
  assert.equal(parseCents('150.00'), 15000);
  assert.equal(parseCents('$1,500.50'), 150050);
  assert.equal(parseCents(' 0.07 '), 7);
  assert.equal(parseCents('-25.00'), -2500);
});

test('parseCents rounds the first dropped digit rather than truncating', () => {
  assert.equal(parseCents('0.005'), 1);
  assert.equal(parseCents('0.004'), 0);
});

test('parseCents returns null for empty and garbage, never 0', () => {
  // An empty rate must not silently become $0.00 on a client's invoice.
  assert.equal(parseCents(''), null);
  assert.equal(parseCents('abc'), null);
  assert.equal(parseCents(null), null);
});

test('line amounts stay exact where floats would not', () => {
  // 0.1 * 15000 in float arithmetic is 1500.0000000000002.
  assert.equal(lineAmountCents(parseQuantity('0.1'), parseCents('150')), 1500);
  assert.equal(lineAmountCents(parseQuantity('12.5'), parseCents('150')), 187500);
  assert.equal(lineAmountCents(parseQuantity('3'), parseCents('99.99')), 29997);
});

test('a long invoice sums without drift', () => {
  const amounts = Array.from({ length: 1000 }, () => lineAmountCents(parseQuantity('0.1'), parseCents('0.10')));
  assert.equal(sumCents(amounts), 1000); // exactly $10.00
});

test('formatting is the only place decimals appear', () => {
  assert.equal(formatUSD(187500), '$1,875.00');
  assert.equal(formatUSD(7), '$0.07');
  assert.equal(formatUSD(-2500), '-$25.00');
  assert.equal(formatQuantity(12500), '12.5');
  assert.equal(formatQuantity(3000), '3');
});

test('input values are valid for an <input type="number">', () => {
  // A number input silently blanks any value the HTML spec calls invalid, and
  // "9,999" is invalid. This is the rule the browser applies, asserted directly.
  for (const milli of [100, 12500, 999000, 1000000, 9999000, 123456789]) {
    const value = quantityInputValue(milli);
    assert.ok(!/[,\s$]/.test(value), `${milli} rendered as "${value}"`);
    assert.ok(!Number.isNaN(Number(value)), `Number("${value}") is NaN`);
  }
});

test('input values round-trip back to the same stored integer', () => {
  // The failure was not just display: the blank field submitted as empty and
  // wrote the quantity back as null, destroying it.
  for (const milli of [100, 12500, 999000, 1000000, 9999000, 123456789]) {
    assert.equal(parseQuantity(quantityInputValue(milli)), milli, `quantity ${milli}`);
  }
  for (const cents of [1, 200, 99999, 150000, 9999900, 123456789]) {
    assert.equal(parseCents(centsInputValue(cents)), cents, `rate ${cents}`);
  }
});

test('display formatting still groups thousands', () => {
  // The grouped forms are still correct for pages and the PDF; they are simply
  // not what goes into a form control.
  assert.equal(formatQuantity(9999000), '9,999');
  assert.equal(formatUSD(1999800), '$19,998.00');
  assert.equal(quantityInputValue(9999000), '9999');
});

test('a null quantity or rate renders an empty field, not a zero', () => {
  assert.equal(quantityInputValue(null), '');
  assert.equal(centsInputValue(null), '');
});


test('zero is a value and empty is not', () => {
  // parseCents returns null for "no answer" so a blank rate is not billed as
  // $0.00. Zero itself has to survive that, and it is falsy, so every caller
  // has to test `!= null` rather than truthiness.
  assert.equal(parseCents('0'), 0);
  assert.equal(parseCents('0.00'), 0);
  assert.equal(parseQuantity('0'), 0);
  assert.equal(parseCents(''), null);
  assert.equal(parseCents('   '), null);
  assert.equal(parseCents(null), null);
  assert.equal(parseCents(undefined), null);

  assert.equal(formatUSD(0), '$0.00');
  assert.equal(formatQuantity(0), '0');
  assert.equal(centsInputValue(0), '0.00');
  assert.equal(quantityInputValue(0), '0');

  assert.equal(formatUSD(null), '', 'a missing value formats as nothing, not as zero');
});

test('negative amounts round away from zero, like positive ones', () => {
  // A credit line is the reason this branch exists. Math.round breaks ties
  // toward positive infinity, so -2.5 would go to -2 without the guard.
  assert.equal(parseCents('-150.00'), -15000);
  assert.equal(parseCents('-0.005'), -1, 'the half rounds away from zero, not toward it');
  assert.equal(lineAmountCents(parseQuantity('-0.5'), parseCents('0.05')), -3);
  assert.equal(lineAmountCents(parseQuantity('2'), parseCents('-150.00')), -30000);
  assert.equal(formatUSD(-187500), '-$1,875.00');
  assert.equal(centsInputValue(-15000), '-150.00');
  assert.equal(sumCents([15000, -5000, null]), 10000);
});
