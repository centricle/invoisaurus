/**
 * Draw an invoice PDF from scratch with pdf-lib.
 *
 * The document is laid out in two passes: the first measures, the second draws.
 * Pagination is handled here rather than bolted on later because a two-page
 * invoice is an ordinary invoice, not an edge case, and retrofitting page
 * breaks into a single-pass drawer means rewriting it.
 *
 * What is drawn is a style's business; where it lands is this file's. A style
 * (src/lib/pdf/styles/) returns lists of draw operations and, with each one,
 * the y coordinate it stopped at. Both passes read those same results, so the
 * space reserved for a block and the space it occupies cannot disagree. They
 * did disagree while the header height was a constant: a client with a second
 * address line pushed rows below the bottom margin, and a short one left a
 * third of the page blank.
 *
 * Nothing here knows what an invoice looks like. Everything here knows what
 * happens when one does not fit on a page.
 */
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import { PAGE, CONTENT, LIST_GAP } from './layout.js';
import { render } from './ops.js';
import { styleFor } from './styles/index.js';
import {
  layoutBlocks, rowHeight, blockHeight, firstBaselineY, linesThatFit, baselines,
} from './richtext.js';
import { parseMarkup, parsePlain } from '../markup.js';
import { formatUSD, formatQuantity, lineAmountCents } from '../../money.js';
import { MARKUP_SCHEMA_VERSION } from '../../schema.js';

/**
 * The measure pass, exported so pagination can be asserted directly.
 *
 * Returns the rows assigned to each page alongside the block layouts they were
 * measured against. A test that counts rows per page is the only thing that
 * catches the header/paginator disagreement described above, because the
 * failure is silent: the PDF still renders, just with rows below the margin.
 *
 * `styleId` defaults rather than being required. Every caller that predates a
 * second style -- and every test that measures pagination -- means classic.
 */
export function planPages(invoice, fonts, styleId = 'classic') {
  const style = styleFor(styleId);
  const { tableHeader, totalsHeight, notesGapAbove, notesGapBelow } = style.metrics;

  // Which parser runs is the whole of the version gate. A record written
  // before the formatting subset existed goes through parsePlain, so an
  // asterisk in a description that was already sent is still an asterisk --
  // an invoice is a record of what was sent, and that applies to what its
  // characters meant as much as to the address they went to.
  const parse = (invoice.schemaVersion ?? 1) >= MARKUP_SCHEMA_VERSION ? parseMarkup : parsePlain;
  const lay = (source, maxWidth) => layoutBlocks(parse(source), fonts, { maxWidth });

  const items = invoice.lineItems.map((li) => {
    const lines = lay(li.description, style.columns.description.width);
    const amountCents = lineAmountCents(li.quantityMilli, li.rateCents);
    return {
      lines,
      height: rowHeight(lines),
      quantity: formatQuantity(li.quantityMilli),
      rate: li.rateCents == null ? '' : formatUSD(li.rateCents),
      amount: formatUSD(amountCents),
      amountCents,
    };
  });

  // Before the headers, not after: a style may print the amount due in its
  // masthead, and a second path computing the same money on the same document
  // is a disagreement waiting for a rounding change.
  const totalCents = items.reduce((sum, item) => sum + item.amountCents, 0);

  const firstHeader = style.header(invoice, fonts, { totalCents });
  const contHeader = style.continuationHeader(invoice, fonts);

  const noteLines = invoice.notes?.trim() ? lay(invoice.notes, CONTENT.width) : [];
  const notesHeight = noteLines.length
    ? notesGapAbove + blockHeight(noteLines) + notesGapBelow
    : 0;

  const capacityOf = (header) => header.endY - tableHeader - CONTENT.bottom;

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
      const take = Math.max(1, linesThatFit(rest, remaining));
      const lines = rest.slice(0, take);
      rest = rest.slice(take);
      current.push({
        lines,
        height: rowHeight(lines),
        quantity: first ? item.quantity : '',
        rate: first ? item.rate : '',
        amount: first ? item.amount : '',
      });
      remaining -= rowHeight(lines);
      first = false;
      if (rest.length) breakPage();
    }
  }
  pages.push(current);

  // The totals block must never run past the bottom margin. If what is left
  // on the last page cannot hold it, start another page and put it there --
  // accepting a page carrying only totals and notes as the cheaper problem.
  if (remaining < totalsHeight + notesHeight) pages.push([]);

  return {
    pages, firstHeader, contHeader, noteLines, notesHeight, totalsHeight,
    totalCents, capacityOf, style,
  };
}

/**
 * The faces a style's drawer needs.
 *
 * Exported because `planPages` takes them, and a test that measures pagination
 * has to embed the same ones the drawer will use.
 */
export const embedFonts = (doc, styleId = 'classic') => styleFor(styleId).embedFonts(doc);

export async function generateInvoicePdf(invoice, { watermark = false } = {}) {
  const style = styleFor(invoice.style);
  const doc = await PDFDocument.create();
  const fonts = await style.embedFonts(doc);
  const { regular: font, bold } = fonts;
  const ink = style.ink;

  const draw = (page, op) => render(page, op, { font, ink });

  /**
   * Draw one laid-out line: its marker to the left of the indent, then its
   * segments left to right, each advancing x by its own measured width.
   *
   * Separate from `draw`, and not a style's business. Everything a style draws
   * is one string anchored left or right; this is the one place a single line
   * is several runs in several faces, and it is drawn identically whatever the
   * style around it looks like.
   */
  const drawLine = (page, line, y, left) => {
    if (line.marker) {
      const width = line.marker.font.widthOfTextAtSize(line.marker.text, line.marker.size);
      page.drawText(line.marker.text, {
        x: left + line.indent - LIST_GAP - width,
        y,
        size: line.marker.size,
        font: line.marker.font,
        color: ink,
      });
    }

    let x = left + line.indent;
    for (const segment of line.segments) {
      page.drawText(segment.text, { x, y, size: segment.size, font: segment.font, color: ink });
      x += segment.font.widthOfTextAtSize(segment.text, segment.size);
    }
  };

  // --- Pass one: measure and paginate ---------------------------------------

  const { pages, firstHeader, contHeader, noteLines, totalCents } = planPages(invoice, fonts, style.id);

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
      const head = style.tableHead(fonts, y);
      for (const op of head.ops) draw(page, op);
      y = head.endY;
    }

    // Each row is a box from `y` down to `y - height`, with its text centered
    // inside and its rule on the bottom edge. Drawing from the top with a fixed
    // pad instead is what made the first row sit tighter than the rest.
    for (const item of rows) {
      const baseline = firstBaselineY(y, item.height, item.lines);
      const ys = baselines(baseline, item.lines);
      item.lines.forEach((line, i) => drawLine(page, line, ys[i], style.columns.description.x));

      y -= item.height;
      for (const op of style.row(item, fonts, { baseline, bottom: y })) draw(page, op);
    }

    if (index === pageCount - 1) {
      const totals = style.totals({ totalCents }, fonts, y);
      for (const op of totals.ops) draw(page, op);
      y = totals.endY;

      if (noteLines.length) {
        const notes = style.notes(fonts, y);
        for (const op of notes.ops) draw(page, op);
        const first = notes.endY - noteLines[0].leading;
        baselines(first, noteLines).forEach((lineY, i) => drawLine(page, noteLines[i], lineY, CONTENT.left));
      }
    }

    for (const op of style.pageFooter({ index, pageCount }, fonts)) draw(page, op);

    // Last, and only in the draw pass. `planPages` must never see this: the
    // measure and draw passes disagreeing about how much space something takes
    // is the exact bug the builders above exist to prevent, and a watermark
    // that reserved layout space would push rows off the page.
    // Drawn over the content rather than under it because pdf-lib has no
    // z-order beyond call order, and a mark hidden behind an opaque box is not
    // a watermark.
    if (watermark) {
      const mark = 'DEMO';
      const size = 110;
      const width = bold.widthOfTextAtSize(mark, size);
      const cap = bold.heightAtSize(size, { descender: false });

      // pdf-lib rotates about the text origin, which is the *start of the
      // baseline*, not the middle of the glyphs. Centering the baseline's
      // midpoint alone leaves the mark visibly low and to the left, because
      // the glyph body sits off the baseline perpendicular to it. So: walk
      // half the width back along the baseline, then half the cap height back
      // along the perpendicular.
      const along = Math.SQRT1_2;   // cos 45 = sin 45
      page.drawText(mark, {
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
