/**
 * The Modern invoice style.
 *
 * Helvetica sets everything a reader reads in sentences; IBM Plex Mono sets
 * everything they scan -- the labels, the dates, the invoice number and every
 * figure. That split is the whole idea. Numerals in a monospaced face are
 * tabular by construction, so a column of amounts lines up on the decimal
 * without anything having to arrange it, and a document whose labels are set
 * in a different voice from its prose reads as something a system produced
 * rather than something typed.
 *
 * Monochrome on purpose. An accent color would have to be somebody's, and the
 * people receiving these invoices are not the people who chose it.
 *
 * The columns are Classic's, untouched. What changes is the masthead, the
 * summary panel, the band behind the column headings, and the faces -- none of
 * which move a number sideways, so the two styles can be read against each
 * other line for line.
 */
import { StandardFonts, rgb } from 'pdf-lib';
import { CONTENT, SIZE, LEADING, COLUMNS } from '../layout.js';
import { text, rule, box } from '../ops.js';
import { embedBundled, MONO_REGULAR, MONO_MEDIUM } from '../fonts.js';
import { formatUSD } from '../../../money.js';
import { addressLines, termById, formatLongDate } from '../../../schema.js';

const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const FAINT = rgb(0.55, 0.58, 0.63);
const RULE = rgb(0.80, 0.82, 0.85);
const RULE_LIGHT = rgb(0.89, 0.91, 0.93);
const BAND = rgb(0.94, 0.945, 0.95);

/** Mono sizes. The eyebrow is small because it is tracked; tracking reads as size. */
const MONO = { eyebrow: 7, stamp: 9.5, cell: 13, total: 13, head: 7, footer: 7.5 };

/** Extra letter spacing, in points. */
const TRACK = { eyebrow: 1, head: 0.75 };

/** The summary panel: its height, and where its two lines sit inside it. */
const STRIP = { height: 44, labelDrop: 15, valueDrop: 33, divider: 300, pad: 12 };

/**
 * Where the metadata labels end.
 *
 * Not the rate column, which is where this started and where it collided:
 * "September 30, 2026" is eighteen monospaced characters, and at 9.5pt that is
 * 103 points of value running back from the right margin -- straight through a
 * label whose right edge sat 84 points in. Classic solved the same problem
 * with 132 points of clearance in Helvetica; mono needs its own number because
 * mono is wider, and every glyph in it is as wide as the widest.
 */
const META_LABEL_RIGHT = CONTENT.right - 120;

/** The band behind the column headings, and the gap under it. */
const BAND_HEIGHT = 16;
const BAND_BLEED = 6;
const BAND_GAP = 4;

const eyebrow = (string, at) => text(string, {
  ...at, size: MONO.eyebrow, tracking: TRACK.eyebrow, color: FAINT,
});

export const modern = {
  id: 'modern',

  ink: INK,
  columns: COLUMNS,

  metrics: {
    // The band is a filled rectangle, so unlike Classic's column headings it
    // spends real height rather than drawing a rule through its own slack.
    tableHeader: BAND_HEIGHT + BAND_GAP,
    totalsHeight: 58,
    notesGapAbove: 44,
    notesGapBelow: 0,
  },

  embedFonts: async (doc) => ({
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await embedBundled(doc, MONO_REGULAR),
    monoMedium: await embedBundled(doc, MONO_MEDIUM),
  }),

  /**
   * Masthead, metadata, summary panel, bill-to.
   *
   * `totalCents` arrives from the paginator rather than being recomputed here.
   * The panel prints the amount due above the fold and the totals block prints
   * it again at the bottom; two paths to the same money on one document is a
   * disagreement waiting for a rounding change.
   */
  header(invoice, fonts, { totalCents }) {
    const { bold, mono, monoMedium } = fonts;
    const vendor = invoice.remitFrom || {};
    const client = invoice.billTo || {};
    const ops = [];

    // Masthead: the vendor's name, the word INVOICE, and a heavy rule.
    const titleY = CONTENT.top - SIZE.title;
    ops.push(text(vendor.name || '', { x: CONTENT.left, y: titleY, size: SIZE.title, font: bold }));
    ops.push(text('INVOICE', {
      right: CONTENT.right, y: titleY, size: MONO.stamp, font: monoMedium,
      tracking: TRACK.eyebrow, color: MUTED,
    }));

    const ruleY = titleY - 14;
    ops.push(rule({ x: CONTENT.left, right: CONTENT.right, y: ruleY, thickness: 2, color: INK }));

    // Remit-from, left. The prose half of the header.
    let leftY = ruleY - 18;
    for (const line of addressLines(vendor.address)) {
      ops.push(text(line, { x: CONTENT.left, y: leftY, color: MUTED }));
      leftY -= LEADING.tight;
    }
    if (vendor.email) {
      ops.push(text(vendor.email, { x: CONTENT.left, y: leftY, color: MUTED }));
      leftY -= LEADING.tight;
    }

    // Invoice metadata, right. Terms and the due date are deliberately not
    // both here: the due date belongs to the panel below, and printing either
    // one twice on a page this size reads as a mistake rather than emphasis.
    let metaY = ruleY - 18;
    for (const [label, value] of [
      ['INVOICE', invoice.id],
      ['ISSUED', formatLongDate(invoice.issueDate)],
      ['TERMS', termById(invoice.terms).label],
    ]) {
      ops.push(eyebrow(label, { right: META_LABEL_RIGHT, y: metaY }));
      ops.push(text(String(value), {
        right: CONTENT.right, y: metaY, size: MONO.stamp, font: mono, color: INK,
      }));
      metaY -= LEADING.body;
    }

    // The summary panel: what is owed, and by when. First thing an accounts
    // payable clerk looks for, so it goes above the line items rather than
    // under them.
    const stripTop = Math.min(leftY, metaY) - 10;
    const stripBottom = stripTop - STRIP.height;
    ops.push(box({
      x: CONTENT.left, y: stripBottom, width: CONTENT.width, height: STRIP.height,
      border: RULE, borderWidth: 0.75,
    }));
    ops.push(box({
      x: CONTENT.left + STRIP.divider, y: stripBottom, width: 0.75, height: STRIP.height,
      fill: RULE,
    }));

    for (const [offset, label, value] of [
      [STRIP.pad, 'AMOUNT DUE', formatUSD(totalCents)],
      [STRIP.divider + STRIP.pad, 'PAYMENT DUE', formatLongDate(invoice.dueDate)],
    ]) {
      ops.push(eyebrow(label, { x: CONTENT.left + offset, y: stripTop - STRIP.labelDrop }));
      ops.push(text(value, {
        x: CONTENT.left + offset, y: stripTop - STRIP.valueDrop,
        size: MONO.cell, font: monoMedium, color: INK,
      }));
    }

    // Bill To.
    let billY = stripBottom - 22;
    ops.push(eyebrow('BILL TO', { x: CONTENT.left, y: billY }));
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

    return { ops, endY: billY - 20 };
  },

  continuationHeader(invoice, { mono }) {
    const y = CONTENT.top - 12;
    return {
      ops: [
        text(`${invoice.id} (continued)`, {
          x: CONTENT.left, y, size: MONO.stamp, font: mono, color: MUTED,
        }),
        rule({ x: CONTENT.left, right: CONTENT.right, y: y - 12, color: RULE }),
      ],
      endY: CONTENT.top - 40,
    };
  },

  /** Column headings, reversed out of a filled band. */
  tableHead({ mono }, y) {
    const baseline = y - 11;
    const head = (string, at) => text(string, {
      ...at, y: baseline, size: MONO.head, tracking: TRACK.head, font: mono, color: MUTED,
    });
    return {
      ops: [
        // The band bleeds a few points past the text column on each side, so
        // the headings have room to breathe inside it without the columns
        // having to move. There are 54 points of margin out there.
        box({
          x: CONTENT.left - BAND_BLEED, y: y - BAND_HEIGHT,
          width: CONTENT.width + BAND_BLEED * 2, height: BAND_HEIGHT, fill: BAND,
        }),
        head('DESCRIPTION', { x: COLUMNS.description.x }),
        head('QTY', { right: COLUMNS.quantity.right }),
        head('RATE', { right: COLUMNS.rate.right }),
        head('AMOUNT', { right: COLUMNS.amount.right }),
      ],
      endY: y - BAND_HEIGHT - BAND_GAP,
    };
  },

  row(item, { mono }, { baseline, bottom }) {
    const figure = (string, right) => text(string, { right, y: baseline, font: mono, color: INK });
    return [
      figure(item.quantity, COLUMNS.quantity.right),
      figure(item.rate, COLUMNS.rate.right),
      figure(item.amount, COLUMNS.amount.right),
      rule({ x: CONTENT.left, right: CONTENT.right, y: bottom, color: RULE_LIGHT }),
    ];
  },

  totals({ totalCents }, { monoMedium }, y) {
    const at = y - 22;
    return {
      ops: [
        rule({ x: COLUMNS.quantity.right, right: CONTENT.right, y: at + 16, thickness: 1.5, color: INK }),
        eyebrow('AMOUNT DUE', { right: COLUMNS.rate.right, y: at }),
        text(formatUSD(totalCents), {
          right: COLUMNS.amount.right, y: at - 2, size: MONO.total, font: monoMedium,
        }),
      ],
      endY: at,
    };
  },

  notes(fonts, y) {
    const at = y - this.metrics.notesGapAbove;
    return {
      ops: [
        rule({ x: CONTENT.left, right: CONTENT.right, y: at + 16, color: RULE_LIGHT }),
        eyebrow('NOTES', { x: CONTENT.left, y: at }),
      ],
      endY: at,
    };
  },

  pageFooter({ index, pageCount }, { mono }) {
    if (pageCount < 2) return [];
    return [text(`Page ${index + 1} of ${pageCount}`, {
      right: CONTENT.right, y: CONTENT.bottom - 18, size: MONO.footer, font: mono, color: FAINT,
    })];
  },
};
