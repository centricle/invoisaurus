/**
 * Page geometry and text measurement for the invoice PDF.
 *
 * Coordinates are pdf-lib's: origin bottom-left, units in points, 72 to the
 * inch. This module holds the fixed geometry -- page box, margins, column
 * positions, type sizes -- and the measurement helpers. generate.js decides
 * what is drawn, and derives the positions that depend on how much content
 * there turned out to be.
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

/**
 * Visual height of a wrapped text block: cap height of the first line, the
 * leading between lines, and the descender of the last.
 */
export const textBlockHeight = (lineCount, size = SIZE.body, leading = LEADING.body) =>
  (METRICS.cap + METRICS.descender) * size + (lineCount - 1) * leading;

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

/**
 * Break text to fit a column, honoring existing newlines.
 *
 * A single word wider than the column is split mid-word rather than allowed to
 * run past the column edge — long URLs in a line-item description are the
 * common case.
 */
export function wrapText(text, font, size, maxWidth) {
  const paragraphs = sanitize(text).split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }

    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);

      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = '';
        for (const char of word) {
          if (chunk && font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            lines.push(chunk);
            chunk = char;
          } else chunk += char;
        }
        line = chunk;
      } else line = word;
    }
    if (line) lines.push(line);
  }

  return lines.length ? lines : [''];
}

export const rowHeight = (lineCount) =>
  Math.max(ROW.minHeight, textBlockHeight(lineCount) + 2 * ROW.padding);

/**
 * The inverse of `rowHeight`: the most description lines that fit in `height`.
 *
 * Pagination normally moves a row that does not fit onto the next page whole,
 * which is right for every row that fits on a page at all. A description long
 * enough to be taller than a whole page has no next page to move to, and was
 * simply drawn past the bottom margin -- silently, because the PDF renders
 * either way. Splitting it needs this measurement.
 *
 * Zero when not even a single-line row fits.
 */
export function linesThatFit(height, size = SIZE.body, leading = LEADING.body) {
  if (height < rowHeight(1)) return 0;
  const block = height - 2 * ROW.padding - (METRICS.cap + METRICS.descender) * size;
  return Math.max(1, Math.floor(block / leading) + 1);
}

/**
 * Baseline of a row's first line so the block sits centered in its box.
 *
 * Rows were previously drawn from the top with a fixed pad, which left the text
 * riding high and put a two-line description almost on top of the rule below
 * it. Centering also makes the first row match every other row, which it did
 * not when the table header's rule and the inter-row rules used different
 * offsets.
 */
export function firstBaselineY(boxTop, boxHeight, lineCount, size = SIZE.body) {
  const block = textBlockHeight(lineCount, size);
  return boxTop - (boxHeight - block) / 2 - METRICS.cap * size;
}
