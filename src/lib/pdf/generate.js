/**
 * Draw an invoice PDF from scratch with pdf-lib.
 *
 * The document is laid out in two passes: the first measures, the second draws.
 * Pagination is handled here rather than bolted on later because a two-page
 * invoice is an ordinary invoice, not an edge case, and retrofitting page
 * breaks into a single-pass drawer means rewriting it.
 *
 * The header is *built* rather than drawn directly — `buildHeader` returns a
 * list of draw operations plus the y coordinate where the table can start. Both
 * the paginator and the drawer read that same result, so the space reserved for
 * the header and the space it actually occupies cannot disagree. They did
 * disagree while the header height was a constant: a client with a second
 * address line pushed rows below the bottom margin, and a short one left a
 * third of the page blank.
 */
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import {
  PAGE, CONTENT, SIZE, LEADING, COLUMNS, TOTALS_HEIGHT, META,
  wrapText, rowHeight, sanitize, firstBaselineY, linesThatFit,
} from './layout.js';
import { formatUSD, formatQuantity, lineAmountCents } from '../../money.js';
import { addressLines, termById, formatLongDate } from '../../schema.js';

const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.80, 0.82, 0.85);

/** Space reserved below the page header for the table's column headings.
 *  The drawer uses 8 of it before the rule; the rest is slack. */
const TABLE_HEADER = 18;

/** A draw operation: left-anchored at `x`, or right-anchored at `right`. */
const at = (string, opts) => ({ string, ...opts });

/**
 * Build the first-page header.
 *
 * Returns the operations to draw and `endY`, the baseline below which the
 * line-item table may begin.
 */
function buildHeader(invoice, { bold }) {
  const vendor = invoice.remitFrom || {};
  const client = invoice.billTo || {};
  const ops = [];

  const titleY = CONTENT.top - SIZE.title;
  ops.push(at(vendor.name || '', { x: CONTENT.left, y: titleY, size: SIZE.title, font: bold }));
  ops.push(at('INVOICE', { right: CONTENT.right, y: titleY, size: SIZE.title, color: MUTED, font: bold }));

  // Remit-from block, left column.
  let leftY = titleY - 20;
  for (const line of addressLines(vendor.address)) {
    ops.push(at(line, { x: CONTENT.left, y: leftY, color: MUTED }));
    leftY -= LEADING.tight;
  }
  if (vendor.email) {
    ops.push(at(vendor.email, { x: CONTENT.left, y: leftY, color: MUTED }));
    leftY -= LEADING.tight;
  }

  // Invoice metadata, right column.
  let metaY = titleY - 22;
  for (const [label, value] of [
    ['Invoice', invoice.id],
    ['Date', formatLongDate(invoice.issueDate)],
    ['Terms', termById(invoice.terms).label],
    ['Payment Due', formatLongDate(invoice.dueDate)],
  ]) {
    ops.push(at(label, { right: META.labelRight, y: metaY, color: MUTED }));
    ops.push(at(String(value), { right: CONTENT.right, y: metaY, font: bold }));
    metaY -= LEADING.body;
  }

  // Bill To sits below whichever column ran longer.
  let billY = Math.min(leftY, metaY) - 24;
  ops.push(at('BILL TO', { x: CONTENT.left, y: billY, size: SIZE.small, color: MUTED, font: bold }));
  billY -= LEADING.body + 2;
  ops.push(at(client.name || '', { x: CONTENT.left, y: billY, font: bold }));
  billY -= LEADING.tight;
  if (client.contactName) {
    ops.push(at(`Attn: ${client.contactName}`, { x: CONTENT.left, y: billY }));
    billY -= LEADING.tight;
  }
  for (const line of addressLines(client.address)) {
    ops.push(at(line, { x: CONTENT.left, y: billY }));
    billY -= LEADING.tight;
  }

  return { ops, endY: billY - 22 };
}

/** Continuation pages carry only the invoice number. */
function buildContinuationHeader(invoice, { bold }) {
  const y = CONTENT.top - 12;
  return {
    ops: [at(`${invoice.id} (continued)`, { x: CONTENT.left, y, size: SIZE.heading, font: bold })],
    endY: CONTENT.top - 40,
  };
}

/**
 * The measure pass, exported so pagination can be asserted directly.
 *
 * Returns the rows assigned to each page alongside the header layouts they were
 * measured against. A test that counts rows per page is the only thing that
 * catches the header/paginator disagreement described above, because the
 * failure is silent: the PDF still renders, just with rows below the margin.
 */
export function planPages(invoice, { font, bold }) {
  const firstHeader = buildHeader(invoice, { bold });
  const contHeader = buildContinuationHeader(invoice, { bold });

  const items = invoice.lineItems.map((li) => {
    const lines = wrapText(li.description, font, SIZE.body, COLUMNS.description.width);
    const amountCents = lineAmountCents(li.quantityMilli, li.rateCents);
    return {
      lines,
      height: rowHeight(lines.length),
      quantity: formatQuantity(li.quantityMilli),
      rate: li.rateCents == null ? '' : formatUSD(li.rateCents),
      amount: formatUSD(amountCents),
      amountCents,
    };
  });

  const noteLines = invoice.notes?.trim()
    ? wrapText(invoice.notes, font, SIZE.body, CONTENT.width)
    : [];
  const notesHeight = noteLines.length ? 24 + noteLines.length * LEADING.body : 0;

  const capacityOf = (header) => header.endY - TABLE_HEADER - CONTENT.bottom;

  const pages = [];
  let current = [];
  let remaining = capacityOf(firstHeader);
  const fullPage = capacityOf(contHeader);

  const breakPage = () => {
    pages.push(current);
    current = [];
    remaining = fullPage;
  };

  for (const item of items) {
    // The ordinary case: a row that does not fit in what is left moves to the
    // next page whole rather than being broken across the boundary.
    if (item.height > remaining && current.length) breakPage();

    if (item.height <= remaining) {
      current.push(item);
      remaining -= item.height;
      continue;
    }

    // It still does not fit and the page is already empty, so there is no next
    // page to move it to -- this row is taller than the space a page can give
    // it. Splitting is the only option that neither drops billed text nor
    // draws it below the bottom margin, and it is what the `current.length`
    // guard above quietly skipped: the row was placed at full height anyway.
    //
    // The numbers ride on the first piece, where the description starts.
    // Continuation pieces carry description only, because a quantity and an
    // amount repeated under themselves read as a second charge.
    let rest = item.lines;
    let first = true;
    while (rest.length) {
      const take = Math.max(1, linesThatFit(remaining));
      const lines = rest.slice(0, take);
      rest = rest.slice(take);
      current.push({
        lines,
        height: rowHeight(lines.length),
        quantity: first ? item.quantity : '',
        rate: first ? item.rate : '',
        amount: first ? item.amount : '',
      });
      remaining -= rowHeight(lines.length);
      first = false;
      if (rest.length) breakPage();
    }
  }
  pages.push(current);

  // The totals block must never run past the bottom margin. If what is left
  // on the last page cannot hold it, start another page and put it there --
  // accepting a page carrying only totals and notes as the cheaper problem.
  if (remaining < TOTALS_HEIGHT + notesHeight) pages.push([]);

  return {
    pages, firstHeader, contHeader, noteLines,
    totalCents: items.reduce((sum, item) => sum + item.amountCents, 0),
    capacityOf,
  };
}

export async function generateInvoicePdf(invoice, { watermark = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const draw = (page, op) => {
    const string = sanitize(op.string);
    const size = op.size ?? SIZE.body;
    const f = op.font ?? font;
    const x = op.right != null ? op.right - f.widthOfTextAtSize(string, size) : op.x;
    page.drawText(string, { x, y: op.y, size, font: f, color: op.color ?? INK });
  };

  const rule = (page, y, color = RULE) => page.drawLine({
    start: { x: CONTENT.left, y }, end: { x: CONTENT.right, y }, thickness: 0.75, color,
  });

  // --- Pass one: measure and paginate ---------------------------------------

  const { pages, firstHeader, contHeader, noteLines, totalCents } = planPages(invoice, { font, bold });

  // --- Pass two: draw --------------------------------------------------------

  const pageCount = pages.length;

  pages.forEach((rows, index) => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const header = index === 0 ? firstHeader : contHeader;
    for (const op of header.ops) draw(page, op);

    let y = header.endY;

    // A page can legitimately carry no rows: the totals block did not fit under
    // the last item and moved here on its own. Column headings above an empty
    // table label nothing, so the table head is drawn only when there is a
    // table under it.
    if (rows.length) {
      draw(page, at('DESCRIPTION', { x: COLUMNS.description.x, y, size: SIZE.small, color: MUTED, font: bold }));
      draw(page, at('QTY', { right: COLUMNS.quantity.right, y, size: SIZE.small, color: MUTED, font: bold }));
      draw(page, at('RATE', { right: COLUMNS.rate.right, y, size: SIZE.small, color: MUTED, font: bold }));
      draw(page, at('AMOUNT', { right: COLUMNS.amount.right, y, size: SIZE.small, color: MUTED, font: bold }));
      y -= 8;
      rule(page, y, INK);
    }

    // Each row is a box from `y` down to `y - height`, with its text centered
    // inside and its rule on the bottom edge. Drawing from the top with a fixed
    // pad instead is what made the first row sit tighter than the rest.
    for (const item of rows) {
      const baseline = firstBaselineY(y, item.height, item.lines.length);
      item.lines.forEach((line, i) => {
        draw(page, at(line, { x: COLUMNS.description.x, y: baseline - i * LEADING.body }));
      });
      draw(page, at(item.quantity, { right: COLUMNS.quantity.right, y: baseline }));
      draw(page, at(item.rate, { right: COLUMNS.rate.right, y: baseline }));
      draw(page, at(item.amount, { right: COLUMNS.amount.right, y: baseline }));

      y -= item.height;
      rule(page, y);
    }

    if (index === pageCount - 1) {
      y -= 18;
      draw(page, at('Amount Due', { right: COLUMNS.rate.right, y, size: SIZE.heading, color: MUTED, font: bold }));
      draw(page, at(formatUSD(totalCents), { right: COLUMNS.amount.right, y: y - 3, size: SIZE.total, font: bold }));

      if (noteLines.length) {
        y -= 44;
        draw(page, at('NOTES', { x: CONTENT.left, y, size: SIZE.small, color: MUTED, font: bold }));
        for (const line of noteLines) {
          y -= LEADING.body;
          draw(page, at(line, { x: CONTENT.left, y }));
        }
      }
    }

    if (pageCount > 1) {
      draw(page, at(`Page ${index + 1} of ${pageCount}`, {
        right: CONTENT.right, y: CONTENT.bottom - 18, size: SIZE.small, color: MUTED,
      }));
    }

    // Last, and only in the draw pass. `planPages` must never see this: the
    // measure and draw passes disagreeing about how much space something takes
    // is the exact bug the buildHeader split above exists to prevent, and a
    // watermark that reserved layout space would push rows off the page.
    // Drawn over the content rather than under it because pdf-lib has no
    // z-order beyond call order, and a mark hidden behind an opaque box is not
    // a watermark.
    if (watermark) {
      const text = 'DEMO';
      const size = 110;
      const width = bold.widthOfTextAtSize(text, size);
      const cap = bold.heightAtSize(size, { descender: false });

      // pdf-lib rotates about the text origin, which is the *start of the
      // baseline*, not the middle of the glyphs. Centering the baseline's
      // midpoint alone leaves the mark visibly low and to the left, because
      // the glyph body sits off the baseline perpendicular to it. So: walk
      // half the width back along the baseline, then half the cap height back
      // along the perpendicular.
      const along = Math.SQRT1_2;   // cos 45 = sin 45
      page.drawText(text, {
        x: PAGE.width / 2 - (width * along) / 2 + (cap * along) / 2,
        y: PAGE.height / 2 - (width * along) / 2 - (cap * along) / 2,
        size,
        font: bold,
        color: rgb(0.85, 0.35, 0.1),
        rotate: degrees(45),
        // Legible enough that nobody mistakes the document for a real invoice,
        // faint enough to read the line items through it. Both matter.
        opacity: 0.16,
      });
    }
  });

  doc.setTitle(`Invoice ${invoice.id}`);
  doc.setAuthor(invoice.remitFrom?.name || '');
  doc.setSubject(`Invoice ${invoice.id} for ${invoice.billTo?.name || ''}`);
  doc.setProducer('Invoisaurus');
  doc.setCreator('Invoisaurus');

  return doc.save();
}
