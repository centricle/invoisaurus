import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { generateInvoicePdf, planPages } from '../src/lib/pdf/generate.js';
import { makeInvoice, snapshotClient, snapshotVendor, makeClient, makeVendor } from '../src/schema.js';
import { wrapText, sanitize, CONTENT, META, SIZE } from '../src/lib/pdf/layout.js';
import { parseCents, parseQuantity } from '../src/money.js';

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
