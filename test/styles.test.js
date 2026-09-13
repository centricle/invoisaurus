import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { PDFDocument } from 'pdf-lib';
import { generateInvoicePdf, planPages, embedFonts } from '../src/lib/pdf/generate.js';
import { STYLES } from '../src/lib/pdf/styles/index.js';
import { lowestInk } from '../src/lib/pdf/ops.js';
import { blockHeight } from '../src/lib/pdf/richtext.js';
import { CONTENT } from '../src/lib/pdf/layout.js';
import {
  makeInvoice, makeVendor, makeClient, snapshotVendor, snapshotClient, INVOICE_STYLES,
} from '../src/schema.js';
import { parseCents, parseQuantity } from '../src/money.js';
import { pdfStrings, pdfText } from './pdftext.js';

/**
 * What is true of every style, whatever it looks like.
 *
 * pdf.test.js pins Classic: its words, its spacing, the specific bugs it has
 * had. This file pins the contract a style signs -- that the space it reserves
 * is the space it spends, and that it never draws below the line it told the
 * paginator it had stopped at. Those are the disagreements that put rows under
 * the bottom margin, and they are the ones a new style is most likely to
 * reintroduce, because nothing about them is visible in the output until the
 * invoice is long enough.
 *
 * Every test here loops over the registry, so a third style is covered by
 * existing.
 */
const ids = Object.keys(STYLES);

const vendor = makeVendor({
  name: 'ACME Corporation', email: 'billing@acme-corp.example', numberPrefix: 'ACM-',
  address: { street: '1 Anvil Plaza', city: 'Sedona', state: 'AZ', zip: '86336' },
});
const client = makeClient({
  name: 'Carnivorous Vulgaris, LLC', contactName: 'Wile E. Coyote',
  address: { street: '22 Mesa Verde Rd', city: 'Tucumcari', state: 'NM', zip: '88401' },
});
const brief = makeClient({
  name: 'Acceleratti Incredibilus, LLC',
  address: { street: '1 Desert Route 66', city: 'Kingman', state: 'AZ', zip: '86401' },
});

const line = (description, qty = '1', rate = '150') => ({
  description, quantityMilli: parseQuantity(qty), rateCents: parseCents(rate),
});

const invoiceWith = (lineItems, extra = {}) => makeInvoice({
  id: 'ACM-0001', number: 1, vendorId: vendor.id, clientId: client.id,
  remitFrom: snapshotVendor(vendor), billTo: snapshotClient(client),
  issueDate: '2026-09-03', terms: 'net30', lineItems, ...extra,
});

const fontsFor = async (id) => embedFonts(await PDFDocument.create(), id);

test('the styles a record may hold are exactly the styles that can be drawn', () => {
  // The list lives in schema.js and the drawers live here, because a schema.js
  // that imported the drawers would close an import cycle and pull pdf-lib
  // into every route. This is the price of that, paid once.
  assert.deepEqual(INVOICE_STYLES.map((s) => s.id).sort(), ids.slice().sort());
});

test('no style draws a header below the line it hands the table', async () => {
  // `endY` is a promise both passes act on: the paginator to work out how many
  // rows fit, the drawer to place the first one. A style that computes it one
  // way and draws something below it puts a row on top of an address.
  for (const id of ids) {
    const fonts = await fontsFor(id);
    for (const [what, billTo] of [
      ['a client with an Attn line', snapshotClient(client)],
      ['a client without one', snapshotClient(brief)],
    ]) {
      const { firstHeader, contHeader } = planPages(
        invoiceWith([line('Anvil')], { billTo }), fonts, id,
      );
      assert.ok(lowestInk(firstHeader.ops) >= firstHeader.endY,
        `${id}: the first-page header draws below its own endY for ${what}`);
      assert.ok(lowestInk(contHeader.ops) >= contHeader.endY,
        `${id}: the continuation header draws below its own endY for ${what}`);
    }
  }
});

test('no style spends more on its table head than it reserved', async () => {
  // Classic's column headings spend 8 of the 18 points they reserve and call
  // the rest slack. Modern's filled band spends real height. Neither may spend
  // more than `tableHeader`, because that is the number the paginator
  // subtracted when it decided how many rows would fit under it.
  for (const id of ids) {
    const fonts = await fontsFor(id);
    const style = STYLES[id];
    const top = 600;
    const head = style.tableHead(fonts, top);
    const floor = top - style.metrics.tableHeader;

    assert.ok(head.endY >= floor,
      `${id}: the table head ends at ${head.endY}, below the ${floor} it reserved`);
    assert.ok(lowestInk(head.ops) >= floor,
      `${id}: the table head draws down to ${lowestInk(head.ops)}, below the ${floor} it reserved`);
  }
});

test('every style reserves exactly the notes space it spends', async () => {
  // The reserve and the draw read one number now. They did not: the measure
  // pass allowed 24 points above the notes label while the drawer spent 44.
  const notes = 'Payment due within 30 days. ACME accepts no liability for outcomes '
    + 'involving cliffs or product used contrary to the manual.';

  for (const id of ids) {
    const fonts = await fontsFor(id);
    const style = STYLES[id];
    const { noteLines, notesHeight } = planPages(
      invoiceWith([line('Anvil')], { notes }), fonts, id,
    );
    const spent = 600 - style.notes(fonts, 600).endY
      + blockHeight(noteLines) + style.metrics.notesGapBelow;

    assert.equal(notesHeight, spent, `${id}: reserves ${notesHeight} for notes and spends ${spent}`);
  }
});

test('no style fills a page past the bottom margin', async () => {
  for (const id of ids) {
    const fonts = await fontsFor(id);
    for (const count of [1, 8, 14, 18, 22, 30, 48]) {
      const items = Array.from({ length: count }, (_, i) => line(`Item ${i + 1}`));
      const { pages, firstHeader, contHeader, capacityOf } = planPages(
        invoiceWith(items), fonts, id,
      );
      pages.forEach((rows, i) => {
        const used = rows.reduce((sum, r) => sum + r.height, 0);
        const available = capacityOf(i === 0 ? firstHeader : contHeader);
        assert.ok(used <= available,
          `${id}: page ${i + 1} of a ${count}-item invoice overflows, ${used} > ${available}`);
      });
    }
  }
});

test('no style leaves the totals or the notes without room on the last page', async () => {
  const notes = '# Payment terms\n- ACH preferred, details on request\n- Check payable to ACME Corporation';

  for (const id of ids) {
    const fonts = await fontsFor(id);
    for (const count of [10, 18, 20, 21, 22, 23, 24, 26]) {
      const items = Array.from({ length: count }, (_, i) => line(`Item ${i + 1}`));
      const { pages, firstHeader, contHeader, capacityOf, notesHeight, totalsHeight } = planPages(
        invoiceWith(items, { notes }), fonts, id,
      );
      const last = pages.length - 1;
      const used = pages[last].reduce((sum, r) => sum + r.height, 0);
      const available = capacityOf(last === 0 ? firstHeader : contHeader);
      assert.ok(used + totalsHeight + notesHeight <= available,
        `${id}: ${count} items need ${Math.round(used + totalsHeight + notesHeight)} of ${Math.round(available)} on the last page`);
    }
  }
});

test('no style splits a row and bills it twice', async () => {
  // A description taller than a whole page is cut across pages, and only the
  // first piece carries the numbers -- a quantity repeated under itself reads
  // as a second charge.
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');

  for (const id of ids) {
    const fonts = await fontsFor(id);
    const { pages, totalCents } = planPages(invoiceWith([line(words, '2', '150')]), fonts, id);
    const priced = pages.flat().filter((r) => r.amount);

    assert.equal(totalCents, 30000, `${id}: the split row is billed once`);
    assert.equal(priced.length, 1, `${id}: only the first piece carries the numbers`);
    assert.equal(priced[0].amount, '$300.00');
  }
});

test('every style renders a whole invoice end to end', async () => {
  for (const id of ids) {
    const invoice = invoiceWith([
      line('Rocket skates (model **XLR-8**): *trajectory* calibration', '3.5', '150'),
      line('Anvil, expedited cliffside delivery', '2', '85'),
    ], { style: id, notes: 'Payment due within 30 days.' });

    const bytes = await generateInvoicePdf(invoice);
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-', `${id} produced no PDF`);
  }
});

test('Modern sets the money and the labels in the mono face', async () => {
  // Asserted through the draw operations rather than by reading the page back.
  // See the test below, and the header comment in test/pdftext.js: a string
  // set in an embedded face does not survive the round trip.
  const fonts = await fontsFor('modern');
  const { firstHeader } = planPages(
    invoiceWith([line('Discovery', '12.5', '150')]), fonts, 'modern',
  );

  const amount = firstHeader.ops.find((op) => op.string === '$1,875.00');
  assert.ok(amount, 'the summary panel prints the amount due');
  assert.equal(amount.font, fonts.monoMedium, 'and prints it in the mono face');

  const eyebrow = firstHeader.ops.find((op) => op.string === 'AMOUNT DUE');
  assert.ok(eyebrow.tracking > 0, 'the panel label is letterspaced');
  assert.equal(eyebrow.font, undefined, 'eyebrows inherit the body face unless a style says otherwise');
});

test('the summary panel and the totals block print one number, not two', async () => {
  // The panel is drawn from the header and the totals from the last page, so
  // the money reaches them by two different routes. It is computed once, above
  // both of them, precisely so those routes cannot disagree.
  const fonts = await fontsFor('modern');
  const invoice = invoiceWith([line('Discovery', '12.5', '150'), line('Anvil', '2', '85')]);
  const { firstHeader, totalCents, style } = planPages(invoice, fonts, 'modern');

  const panel = firstHeader.ops.find((op) => /^\$/.test(op.string ?? ''));
  const totals = style.totals({ totalCents }, fonts, 400).ops.find((op) => /^\$/.test(op.string ?? ''));
  assert.equal(panel.string, totals.string);
  assert.equal(panel.string, '$2,045.00');
});

test('a string set in an embedded face does not come back out of pdfText', async () => {
  // pdf-lib writes an embedded font as Type0/Identity-H, so its Tj operands
  // are glyph indices rather than character codes. This is worth a test rather
  // than a comment: `assert.ok(!pdfText(bytes).includes('$1,875.00'))` passes
  // against a Modern invoice whatever the page actually says, so anyone
  // reaching for pdfText to check Modern's numbers gets a green test that
  // means nothing. If this ever fails, pdftext.js has learned to read them and
  // the op-list assertions above can be simplified.
  const invoice = invoiceWith([line('Rocket skates', '12.5', '150')], { style: 'modern' });
  const bytes = await generateInvoicePdf(invoice);

  assert.ok(!pdfStrings(bytes).includes('$1,875.00'), 'mono text is still unreadable');
  assert.ok(pdfText(bytes).includes('Rocket skates'), 'the Helvetica half still reads back');
});

test('Modern fits fewer rows on its first page than Classic', async () => {
  // Not a rule, an observation worth pinning: the summary panel costs vertical
  // space that Classic spends on line items. If this ever reverses, something
  // has quietly changed about one of the two headers.
  const items = Array.from({ length: 40 }, (_, i) => line(`Item ${i + 1}`));
  const classic = planPages(invoiceWith(items), await fontsFor('classic'), 'classic');
  const modern = planPages(invoiceWith(items), await fontsFor('modern'), 'modern');

  assert.ok(modern.pages[0].length < classic.pages[0].length,
    `Modern fits ${modern.pages[0].length} rows on page one, Classic ${classic.pages[0].length}`);
  assert.ok(CONTENT.width === 504, 'both styles are still laid out in the same content box');
});
