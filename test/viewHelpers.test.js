import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { field, escapeHtml, statusBadgeClass } from '../src/viewHelpers.js';

/**
 * `field` builds markup and every template emits it with raw `<%-`, so it is
 * the app's only escaping boundary for client names, legal names, contact
 * names, address lines and vendor prefixes. EJS is not protecting any of it.
 */

test('escapeHtml covers the five characters that matter in markup', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml('Coyote & Sons'), 'Coyote &amp; Sons');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0', 'zero is a value, not an absence');
});

test('a quote in a value cannot escape the value attribute', () => {
  const html = field('name', 'Legal name', '" autofocus onfocus="alert(1)');
  assert.ok(!html.includes('onfocus="alert(1)"'), 'no attribute was injected');
  assert.ok(html.includes('&quot; autofocus onfocus=&quot;alert(1)'));
});

test('markup in a client name renders as text', () => {
  const html = field('name', 'Legal name', '<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the label, hint and placeholder are escaped too', () => {
  const html = field('x', '<b>Label</b>', '', { hint: '<i>hint</i>', placeholder: '"quoted"' });
  assert.ok(!html.includes('<b>'));
  assert.ok(!html.includes('<i>'));
  assert.ok(html.includes('placeholder="&quot;quoted&quot;"'));
});

test('optional attributes are omitted rather than emitted empty', () => {
  const bare = field('x', 'X', '');
  for (const attr of ['placeholder=', 'min=', 'max=', 'data-stepper']) {
    assert.ok(!bare.includes(attr), `${attr} should not appear when not asked for`);
  }

  const stepped = field('numberPad', 'Digits', 4, { type: 'number', min: 1, max: 10, stepper: 1 });
  assert.ok(stepped.includes('min="1"'));
  assert.ok(stepped.includes('max="10"'));
  assert.ok(stepped.includes('data-stepper data-step-amount="1"'));
});

test('an unrecognized status still gets a badge', () => {
  // Statuses come off stored records, so a hand-edited file or a future status
  // must not render an unstyled badge or crash the list.
  assert.equal(statusBadgeClass('nonsense'), statusBadgeClass('draft'));
  assert.equal(statusBadgeClass(undefined), statusBadgeClass('draft'));
  assert.notEqual(statusBadgeClass('paid'), statusBadgeClass('draft'));
});
