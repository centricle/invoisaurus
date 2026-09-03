import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCents, parseQuantity, lineAmountCents, formatUSD, formatQuantity, sumCents } from '../src/money.js';

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
