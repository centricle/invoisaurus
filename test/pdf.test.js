import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { generateInvoicePdf, planPages } from '../src/lib/pdf/generate.js';
import { makeInvoice, snapshotClient, snapshotVendor, makeClient, makeVendor } from '../src/schema.js';
import { wrapText, sanitize, CONTENT, META, SIZE } from '../src/lib/pdf/layout.js';
import { parseCents, parseQuantity } from '../src/money.js';
import { pdfStrings, pdfText } from './pdftext.js';

const vendor = makeVendor({
  name: 'ACME Corporation', email: 'billing@acme-corp.example', numberPrefix: 'ACM-',
  address: { street: '1 Anvil Plaza', city: 'Sedona', state: 'AZ', zip: '86336' },
});
const client = makeClient({
  name: 'Carnivorous Vulgaris, LLC', contactName: 'Wile E. Coyote',
  address: { street: '500 Harbor Blvd', city: 'Sedona', state: 'AZ', zip: '86336' },
});

const invoiceWith = (lineItems, extra = {}) => makeInvoice({
  id: 'ACM-0001', number: 1, vendorId: vendor.id, clientId: client.id,
  remitFrom: snapshotVendor(vendor), billTo: snapshotClient(client),
  issueDate: '2026-09-03', terms: 'net30', lineItems, ...extra,
});

const line = (description, qty = '1', rate = '150') => ({
  description, quantityMilli: parseQuantity(qty), rateCents: parseCents(rate),
});

const pageCount = async (invoice) =>
  (await PDFDocument.load(await generateInvoicePdf(invoice))).getPageCount();

test('a short invoice is one page', async () => {
  assert.equal(await pageCount(invoiceWith([line('Discovery', '12.5'), line('Build', '8')])), 1);
});

test('a long invoice paginates instead of running off the page', async () => {
  const many = Array.from({ length: 40 }, (_, i) => line(`Line item number ${i + 1}`, '1.5'));
  const pages = await pageCount(invoiceWith(many));
  assert.ok(pages > 1, `expected more than one page, got ${pages}`);
});

test('the totals block is never orphaned onto a page of its own by accident', async () => {
  // Sweep a range of item counts across the page boundary; every one must
  // produce a valid document rather than a row drawn below the bottom margin.
  for (let count = 22; count <= 30; count += 1) {
    const items = Array.from({ length: count }, (_, i) => line(`Item ${i + 1}`));
    const doc = await PDFDocument.load(await generateInvoicePdf(invoiceWith(items)));
    assert.ok(doc.getPageCount() >= 1);
  }
});

test('notes push to a new page rather than colliding with the totals', async () => {
  const items = Array.from({ length: 24 }, (_, i) => line(`Item ${i + 1}`));
  const notes = 'Payment by ACH or check. '.repeat(30);
  assert.ok(await pageCount(invoiceWith(items, { notes })) >= 2);
});

test('a description too long for its column wraps', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = wrapText('word '.repeat(60), font, 9.5, 262);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 9.5) <= 262);
});

test('an unbroken token wider than the column is split, not overflowed', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const url = `https://example.com/${'a'.repeat(300)}`;
  const lines = wrapText(url, font, 9.5, 262);
  for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 9.5) <= 262);
});

test('characters outside WinAnsi do not crash generation', async () => {
  // The standard PDF fonts throw on unrepresentable glyphs; an emoji in a
  // description must not turn a billable invoice into a 500.
  const invoice = invoiceWith([line('Consulting 🚀 — “design” → build')]);
  const bytes = await generateInvoicePdf(invoice);
  assert.ok(bytes.length > 0);
  assert.equal(sanitize('🚀'), '');
  assert.equal(sanitize('“x”'), '"x"');
});

test('the PDF carries the invoice number in its metadata', async () => {
  const doc = await PDFDocument.load(await generateInvoicePdf(invoiceWith([line('Work')])));
  assert.equal(doc.getTitle(), 'Invoice ACM-0001');
  assert.equal(doc.getAuthor(), 'ACME Corporation');
});

test('content width matches US Letter with 0.75in margins', () => {
  assert.equal(CONTENT.width, 504);
});

test('pagination reacts to the actual header height, not an assumed one', async () => {
  // This is the regression guard for a silent bug: the paginator once reserved
  // a constant 250pt for the header while the drawer used the real one. A
  // client with more address lines pushed rows below the bottom margin, and a
  // short header wasted a third of the first page. Neither shows up as an
  // error — the PDF renders either way — so only a row count catches it.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const tallClient = makeClient({
    name: 'A Company With A Long Name, LLC', contactName: 'Wile E. Coyote',
    address: { street: '500 Harbor Blvd', street2: 'Building C, Suite 210', city: 'Sedona', state: 'AZ', zip: '86336' },
  });
  const shortClient = makeClient({ name: 'Coyote', address: { city: 'Sedona', state: 'AZ', zip: '86336' } });

  const items = Array.from({ length: 40 }, (_, i) => line(`Item ${i + 1}`));
  const plan = (c) => planPages(
    invoiceWith(items, { billTo: snapshotClient(c) }), { font, bold },
  );

  const tall = plan(tallClient);
  const short = plan(shortClient);

  assert.ok(
    tall.pages[0].length < short.pages[0].length,
    `a taller header must fit fewer rows on page one (tall: ${tall.pages[0].length}, short: ${short.pages[0].length})`,
  );
});

test('no page is filled past the bottom margin', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const count of [1, 12, 23, 24, 25, 40, 80]) {
    const items = Array.from({ length: count }, (_, i) => line(`Item ${i + 1} with a description long enough to sometimes wrap onto a second line`));
    const { pages, firstHeader, contHeader, capacityOf } = planPages(invoiceWith(items), { font, bold });
    pages.forEach((rows, i) => {
      const used = rows.reduce((sum, r) => sum + r.height, 0);
      const available = capacityOf(i === 0 ? firstHeader : contHeader);
      assert.ok(used <= available, `page ${i + 1} of ${count}-item invoice overflows: ${used} > ${available}`);
    });
  }
});

test('a line item taller than a whole page is split, not drawn off the page', async () => {
  // Pagination moves a row that does not fit onto the next page, but a row
  // taller than a page has no page to move to: the `current.length` guard that
  // stops an infinite run of empty pages also placed it regardless of height,
  // and it was drawn straight through the bottom margin. The sweep below only
  // used short descriptions, so nothing caught it.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const huge = line('word '.repeat(400), '2', '150');
  const { pages, firstHeader, contHeader, capacityOf, totalCents } = planPages(
    invoiceWith([huge]), { font, bold },
  );

  assert.ok(pages.length > 1, 'the row needed more than one page');
  pages.forEach((rows, i) => {
    const used = rows.reduce((sum, r) => sum + r.height, 0);
    const available = capacityOf(i === 0 ? firstHeader : contHeader);
    assert.ok(used <= available, `page ${i + 1} overflows: ${used} > ${available}`);
  });

  // Splitting must not turn one charge into several.
  assert.equal(totalCents, 30000, 'the split row is still billed once');
  const priced = pages.flat().filter((r) => r.amount);
  assert.equal(priced.length, 1, 'only the first piece carries the numbers');
  assert.equal(priced[0].amount, '$300.00');
  assert.equal(priced[0].quantity, '2');
});

test('a split row keeps every word of its description', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Distinct tokens, so a dropped or duplicated chunk is visible.
  const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ');
  const { pages } = planPages(invoiceWith([line(words)]), { font, bold });

  const drawn = pages.flat().flatMap((r) => r.lines).join(' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(drawn, words.split(' '), 'no word is lost or repeated across the break');
});

test('a document with an oversized row still renders', async () => {
  const bytes = await generateInvoicePdf(invoiceWith([
    line('Preamble'),
    line('word '.repeat(400), '2', '150'),
    line('Postscript'),
  ]));
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2);

  const text = pdfText(bytes);
  assert.ok(text.includes('Preamble'));
  assert.ok(text.includes('Postscript'));
  assert.ok(text.includes('Amount Due'));
});

test('long-form dates never collide with their metadata labels', async () => {
  // The header labels sat at the line-item rate column until dates became
  // long-form. "September 30, 2026" is wide enough that the value ran into the
  // "Date" label. Nothing errors when this happens; the text just overlaps.
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const widest = ['September 30, 2026', 'November 30, 2026', 'December 31, 2026'];
  for (const value of widest) {
    const valueStart = CONTENT.right - bold.widthOfTextAtSize(value, SIZE.body);
    assert.ok(
      valueStart > META.labelRight,
      `"${value}" starts at ${valueStart.toFixed(1)}, label column ends at ${META.labelRight}`,
    );
  }
});

test('every row in a table is the same height as its neighbors', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Single-line rows must all measure identically, including the first, which
  // used to sit tighter because the header rule and the inter-row rules were
  // offset differently.
  const items = Array.from({ length: 5 }, (_, i) => line(`Item ${i + 1}`));
  const { pages } = planPages(invoiceWith(items), { font, bold });
  const heights = new Set(pages[0].map((r) => r.height));
  assert.equal(heights.size, 1, `expected uniform row heights, got ${[...heights].join(', ')}`);
});

test('characters WinAnsi cannot encode are dropped, not passed to pdf-lib', async () => {
  // 0x7F and the C1 block 0x80-0x9F sit inside Latin-1's range but have no
  // WinAnsi encoding, and pdf-lib throws rather than substituting. A single
  // U+0085 pasted out of an RTF export turned the whole PDF route into a 500.
  const control = '\u007F\u0080\u0085\u009D\u009F';
  assert.equal(sanitize(`Design${control} work`), 'Design work');

  // The printable glyphs WinAnsi puts at 0x80-0x9F are still reached by their
  // real code points, so this must not become a blanket ban on the high range.
  // Curly quotes are substituted, as they always were; the euro and the em
  // dash survive intact, which is what would break under a blanket ban.
  assert.equal(sanitize('€ — “quoted” ™'), '€ — "quoted" ™');
  assert.equal(sanitize('caf\u00E9 na\u00EFve'), 'caf\u00E9 na\u00EFve');

  const bytes = await generateInvoicePdf(invoiceWith([{
    description: `Discovery${control}`, quantityMilli: 1000, rateCents: 15000,
  }]));
  assert.ok(bytes.length > 0, 'a control character must not fail the render');
});


test('the document prints formatted currency, not raw cents', async () => {
  // Every other assertion in this file is geometric, and geometry cannot tell
  // "$1,875.00" from "187500" -- both are just a string in the amount column.
  // Reading the text back is the only check that the client receives money.
  const invoice = invoiceWith([line('Discovery', '12.5'), line('Build', '2', '85')]);
  const strings = pdfStrings(await generateInvoicePdf(invoice));
  const text = strings.join('\n');

  assert.ok(text.includes('$150.00'), 'the rate column is currency');
  assert.ok(text.includes('$1,875.00'), 'so is the amount column, grouped at the thousand');
  assert.ok(text.includes('$2,045.00'), 'and the total');
  assert.ok(text.includes('Amount Due'));

  for (const raw of ['187500', '15000', '204500']) {
    assert.ok(!strings.includes(raw), `raw cents (${raw}) must never reach the page`);
  }
});

test('quantities print without trailing zeros and dates print long', async () => {
  const text = pdfText(await generateInvoicePdf(invoiceWith([line('Discovery', '12.5'), line('Build', '8')])));
  assert.ok(text.includes('12.5'), 'a fractional quantity keeps its fraction');
  assert.ok(!text.includes('12.500'), 'but not the padding it is stored with');
  assert.ok(text.includes('8'), 'a whole quantity has no decimal point');
  assert.ok(text.includes('September 3, 2026'), 'the issue date');
  assert.ok(text.includes('October 3, 2026'), 'and the due date the terms imply');
});

test('a snapshot the registry has moved on from still prints', async () => {
  // The snapshot has to be a copy, not a view. This is the unit-level half of
  // the guarantee; routes.test.js asserts it end to end through the PDF route.
  const invoice = invoiceWith([line('Discovery')]);

  vendor.name = 'ACME Holdings LLC';
  vendor.address.street = '4 Ledge Court';
  client.address.street = '9 Rimrock Way';
  try {
    const text = pdfText(await generateInvoicePdf(invoice));
    assert.ok(text.includes('ACME Corporation'));
    assert.ok(text.includes('1 Anvil Plaza'));
    assert.ok(text.includes('500 Harbor Blvd'));
    assert.ok(!text.includes('ACME Holdings LLC'));
    assert.ok(!text.includes('9 Rimrock Way'));
  } finally {
    vendor.name = 'ACME Corporation';
    vendor.address.street = '1 Anvil Plaza';
    client.address.street = '500 Harbor Blvd';
  }
});

test('an invoice with no line items still renders a document', async () => {
  // saveInvoice does not validate, so an empty invoice can reach the PDF route
  // from a hand-edited file. It must not be the thing that turns a page into a
  // 500: planPages produces one empty page and the table head is skipped.
  const empty = invoiceWith([]);
  const bytes = await generateInvoicePdf(empty);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);

  const text = pdfText(bytes);
  assert.ok(text.includes('Amount Due'));
  assert.ok(text.includes('$0.00'), 'a total of nothing is still a total');
  assert.ok(!text.includes('DESCRIPTION'), 'no column headings over an empty table');
});

test('the demo watermark is drawn, and only when asked for', async () => {
  const invoice = invoiceWith([line('Consulting')]);

  const plain = pdfStrings(await generateInvoicePdf(invoice)).join('\n');
  const marked = pdfStrings(await generateInvoicePdf(invoice, { watermark: true })).join('\n');

  assert.ok(!plain.includes('DEMO'), 'a real invoice must never carry it');
  assert.ok(marked.includes('DEMO'));
});

test('the watermark does not move a single row', async () => {
  // The measure pass and the draw pass disagreeing about how much space
  // something occupies is the bug that put rows below the bottom margin once
  // already (see the header note at the top of generate.js). The watermark is
  // drawn in the second pass only, so pagination must be untouched -- checked
  // across a page boundary, where a one-row drift would show up.
  for (const count of [1, 14, 15, 16, 35]) {
    const invoice = invoiceWith(Array.from({ length: count }, (_, i) => line(`Item ${i + 1}`)));

    const plain = await PDFDocument.load(await generateInvoicePdf(invoice));
    const marked = await PDFDocument.load(await generateInvoicePdf(invoice, { watermark: true }));
    assert.equal(marked.getPageCount(), plain.getPageCount(), `${count} lines paginated differently`);

    const strip = (s) => s.filter((t) => t !== 'DEMO');
    assert.deepEqual(
      strip(pdfStrings(await generateInvoicePdf(invoice, { watermark: true }))),
      pdfStrings(await generateInvoicePdf(invoice)),
      `${count} lines: the watermark changed what else was drawn`,
    );
  }
});

test('every page of a multi-page demo invoice is watermarked', async () => {
  // One mark on page one would leave later pages looking like a real invoice,
  // which is the page someone would screenshot to claim it was.
  const invoice = invoiceWith(Array.from({ length: 40 }, (_, i) => line(`Item ${i + 1}`)));
  const bytes = await generateInvoicePdf(invoice, { watermark: true });

  const pageCount = (await PDFDocument.load(bytes)).getPageCount();
  assert.ok(pageCount > 1, 'the fixture should span pages');

  const marks = pdfStrings(bytes).filter((t) => t === 'DEMO').length;
  assert.equal(marks, pageCount);
});
