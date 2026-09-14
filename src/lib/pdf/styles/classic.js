/**
 * The original invoice style: Helvetica throughout, hairline rules, no fills.
 *
 * Everything here is something a style is entitled to disagree about -- the
 * faces, the colors, the words, the vertical rhythm, and the numbers both
 * passes of generate.js read. Everything a style is *not* entitled to
 * disagree about -- how rows are paginated, how a row taller than a page is
 * split, how a laid-out description is drawn -- stayed in generate.js. A
 * second copy of any of that would be a second place for the measure and draw
 * passes to fall out of step, which is the failure this file's neighbor spends
 * its whole header comment on.
 *
 * This was generate.js until a second style needed to exist. It is lifted, not
 * rewritten: the content streams it produces are byte-identical to the ones it
 * produced as part of that file.
 */
import { StandardFonts, rgb } from 'pdf-lib';
import { CONTENT, SIZE, LEADING, COLUMNS, META } from '../layout.js';
import { text, rule } from '../ops.js';
import { formatUSD } from '../../../money.js';
import { addressLines, termById, formatLongDate } from '../../../schema.js';

const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.80, 0.82, 0.85);

export const classic = {
  id: 'classic',

  ink: INK,
  columns: COLUMNS,

  /**
   * Numbers both passes read.
   *
   * A style may hold these nowhere else. The notes gap lived in two places
   * once, the reserve said 24 and the drawer spent 44, and the measure pass
   * spent a release twenty points optimistic about a block it was supposed to
   * be keeping off the bottom margin.
   *
   * `tableHeader` is the space below the page header reserved for the column
   * headings. The drawer uses 8 of it before the rule; the rest is slack.
   */
  metrics: {
    tableHeader: 18,
    totalsHeight: 58,
    notesGapAbove: 44,
    notesGapBelow: 0,
  },

  /**
   * The four faces the drawer needs.
   *
   * All four are Standard 14, so the obliques cost the document nothing: no
   * font file, no fontkit, no embedded bytes. They exist so a description can
   * carry an italic phrase.
   */
  embedFonts: async (doc) => ({
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  }),

  /**
   * The first-page header.
   *
   * Returns the operations to draw and `endY`, the baseline below which the
   * line-item table may begin. Both the paginator and the drawer read that
   * same result, so the space reserved for the header and the space it
   * actually occupies cannot disagree. They did disagree while the header
   * height was a constant: a client with a second address line pushed rows
   * below the bottom margin, and a short one left a third of the page blank.
   */
  header(invoice, { bold }) {
    const vendor = invoice.remitFrom || {};
    const client = invoice.billTo || {};
    const ops = [];

    const titleY = CONTENT.top - SIZE.title;
    ops.push(text(vendor.name || '', { x: CONTENT.left, y: titleY, size: SIZE.title, font: bold }));
    ops.push(text('INVOICE', { right: CONTENT.right, y: titleY, size: SIZE.title, color: MUTED, font: bold }));

    // Remit-from block, left column.
    let leftY = titleY - 20;
    for (const line of addressLines(vendor.address)) {
      ops.push(text(line, { x: CONTENT.left, y: leftY, color: MUTED }));
      leftY -= LEADING.tight;
    }
    if (vendor.email) {
      ops.push(text(vendor.email, { x: CONTENT.left, y: leftY, color: MUTED }));
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
      ops.push(text(label, { right: META.labelRight, y: metaY, color: MUTED }));
      ops.push(text(String(value), { right: CONTENT.right, y: metaY, font: bold }));
      metaY -= LEADING.body;
    }

    // Bill To sits below whichever column ran longer.
    let billY = Math.min(leftY, metaY) - 24;
    ops.push(text('BILL TO', { x: CONTENT.left, y: billY, size: SIZE.small, color: MUTED, font: bold }));
    billY -= LEADING.body + 2;
    ops.push(text(client.name || '', { x: CONTENT.left, y: billY, font: bold }));
    billY -= LEADING.tight;
    if (client.contactName) {
      ops.push(text(`Attn: ${client.contactName}`, { x: CONTENT.left, y: billY }));
      billY -= LEADING.tight;
    }
    for (const line of addressLines(client.address)) {
      ops.push(text(line, { x: CONTENT.left, y: billY }));
      billY -= LEADING.tight;
    }

    return { ops, endY: billY - 22 };
  },

  /** Continuation pages carry only the invoice number. */
  continuationHeader(invoice, { bold }) {
    const y = CONTENT.top - 12;
    return {
      ops: [text(`${invoice.id} (continued)`, { x: CONTENT.left, y, size: SIZE.heading, font: bold })],
      endY: CONTENT.top - 40,
    };
  },

  /** Column headings and the rule under them. `endY` is the table's top edge. */
  tableHead({ bold }, y) {
    const head = (string, at) => text(string, { ...at, y, size: SIZE.small, color: MUTED, font: bold });
    return {
      ops: [
        head('DESCRIPTION', { x: COLUMNS.description.x }),
        head('QTY', { right: COLUMNS.quantity.right }),
        head('RATE', { right: COLUMNS.rate.right }),
        head('AMOUNT', { right: COLUMNS.amount.right }),
        rule({ x: CONTENT.left, right: CONTENT.right, y: y - 8, color: INK }),
      ],
      endY: y - 8,
    };
  },

  /**
   * One row's numbers, and the rule closing it.
   *
   * The description is not here: generate.js draws it, because a laid-out
   * block of rich text is drawn the same way whatever the style.
   */
  row(item, fonts, { baseline, bottom }) {
    return [
      text(item.quantity, { right: COLUMNS.quantity.right, y: baseline }),
      text(item.rate, { right: COLUMNS.rate.right, y: baseline }),
      text(item.amount, { right: COLUMNS.amount.right, y: baseline }),
      rule({ x: CONTENT.left, right: CONTENT.right, y: bottom, color: RULE }),
    ];
  },

  /** The amount due. `endY` is the line the notes block measures down from. */
  totals({ totalCents }, { bold }, y) {
    const at = y - 18;
    return {
      ops: [
        text('Amount Due', { right: COLUMNS.rate.right, y: at, size: SIZE.heading, color: MUTED, font: bold }),
        text(formatUSD(totalCents), { right: COLUMNS.amount.right, y: at - 3, size: SIZE.total, font: bold }),
      ],
      endY: at,
    };
  },

  /** The notes label. `endY` is its baseline; the text hangs below it. */
  notes({ bold }, y) {
    const at = y - this.metrics.notesGapAbove;
    return {
      ops: [text('NOTES', { x: CONTENT.left, y: at, size: SIZE.small, color: MUTED, font: bold })],
      endY: at,
    };
  },

  /** Page numbers, on multi-page documents only. */
  pageFooter({ index, pageCount }) {
    if (pageCount < 2) return [];
    return [text(`Page ${index + 1} of ${pageCount}`, {
      right: CONTENT.right, y: CONTENT.bottom - 18, size: SIZE.small, color: MUTED,
    })];
  },
};
