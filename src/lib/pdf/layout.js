/**
 * Page geometry and text measurement for the invoice PDF.
 *
 * Coordinates are pdf-lib's: origin bottom-left, units in points, 72 to the
 * inch. This module holds the fixed geometry -- page box, margins, column
 * positions, type sizes -- and the character folding every string passes
 * through. richtext.js turns parsed blocks into lines against this geometry;
 * generate.js decides what is drawn, and derives the positions that depend on
 * how much content there turned out to be.
 */

export const PAGE = { width: 612, height: 792 }; // US Letter
export const MARGIN = { top: 54, right: 54, bottom: 54, left: 54 };

export const CONTENT = {
  left: MARGIN.left,
  right: PAGE.width - MARGIN.right,
  top: PAGE.height - MARGIN.top,
  bottom: MARGIN.bottom,
  get width() { return this.right - this.left; },
};

export const SIZE = { title: 20, heading: 10, body: 9.5, small: 8, total: 13 };
export const LEADING = { body: 13, tight: 11 };

/**
 * A heading inside a description or a notes block.
 *
 * `spaceAbove` applies only when something precedes it. A heading opening a
 * description has nothing to separate itself from, and the space would just
 * push the text off-center in its row.
 */
export const SUBHEAD = { size: 11, leading: 15, spaceAbove: 6 };

/** Gap between a list marker and the text it introduces. */
export const LIST_GAP = 4;

/** Column geometry for the line-item table. Numeric columns are right-aligned. */
export const COLUMNS = {
  description: { x: CONTENT.left, width: 262 },
  quantity: { right: CONTENT.left + 330 },
  rate: { right: CONTENT.left + 420 },
  amount: { right: CONTENT.right },
};

/**
 * The invoice-metadata block, top right.
 *
 * Its label column is deliberately not the line-item rate column. They were the
 * same until dates became long-form: "September 3, 2026" is wide enough that
 * the value ran straight into the "Date" label sitting at the rate column's
 * right edge.
 */
export const META = { labelRight: CONTENT.right - 132 };

export const ROW = { padding: 9, minHeight: 30 };

/** Approximate vertical metrics for Helvetica, as fractions of font size. */
export const METRICS = { cap: 0.72, descender: 0.21 };

/** Vertical space the totals block needs, so pagination can reserve it. */
export const TOTALS_HEIGHT = 58;

/**
 * The standard PDF fonts use WinAnsi encoding, and pdf-lib throws when asked to
 * draw a character outside it. A client name with a CJK character or an emoji
 * would otherwise turn a failed invoice into a 500.
 *
 * Only the primes and the true minus sign are in this table for that reason:
 * they have no WinAnsi code point and would otherwise be dropped. The quotes,
 * the en dash, the ellipsis and the non-breaking space are all perfectly
 * representable and get folded to ASCII anyway, because a description pasted
 * out of a word processor arrives with whichever of them that program preferred
 * and an invoice gains nothing by preserving the distinction. The soft hyphen
 * is dropped outright: nothing here hyphenates, so it could only ever be an
 * invisible character sitting inside a word. The em dash and the bullet survive
 * intact, by way of WINANSI_EXTRAS below.
 */
const SUBSTITUTIONS = new Map(Object.entries({
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"',
  '–': '-', '…': '...', ' ': ' ',
  '′': "'", '″': '"', '−': '-', '­': '',
}));

// WinAnsi's high range beyond Latin-1: the printable characters at 0x80-0x9F.
const WINANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function sanitize(text) {
  let out = '';
  for (const char of String(text ?? '')) {
    if (SUBSTITUTIONS.has(char)) { out += SUBSTITUTIONS.get(char); continue; }
    const code = char.codePointAt(0);
    if (char === '\n' || char === '\t') { out += char; continue; }
    // 0x7F and the C1 block 0x80-0x9F sit inside this range but have no
    // WinAnsi encoding, and pdf-lib throws rather than substituting -- one
    // U+0085 pasted from an RTF export turned the whole PDF route into a 500.
    // The printable glyphs that live at 0x80-0x9F in WinAnsi are reached by
    // their real code points through WINANSI_EXTRAS below.
    if (code >= 0x20 && code <= 0xFF && !(code >= 0x7F && code <= 0x9F)) { out += char; continue; }
    if (WINANSI_EXTRAS.has(char)) { out += char; continue; }
    // Unrepresentable. Drop it rather than drawing a wrong glyph.
  }
  return out;
}
