/**
 * Parsed blocks to drawable lines.
 *
 * layout.js used to measure a text block from a line *count*, on the standing
 * assumption that every line was body size at body leading. A heading is 11pt
 * on 15 and a list item is indented, so a count no longer describes a block.
 * Every helper here takes the laid-out lines themselves and measures them.
 *
 * A line is:
 *
 *   { segments, indent, size, leading, marker? }
 *
 * `segments` are drawn left to right from `indent`, each in its own font, so a
 * bold phrase mid-sentence is a segment rather than a separate line. `leading`
 * is the distance from the previous line's baseline down to this one, which is
 * what lets a heading carry its own spacing without the block needing to know a
 * heading is in it. `marker` is a list bullet or number, drawn to the left of
 * `indent` so wrapped text hangs under the text rather than under the bullet.
 */
import { SIZE, LEADING, ROW, METRICS, SUBHEAD, LIST_GAP, sanitize } from './layout.js';

/** The bullet. In WinAnsi, so it survives sanitize() and the standard fonts. */
const BULLET = '•';

const fontFor = (fonts, style) => {
  if (style.bold) return style.italic ? fonts.boldItalic : fonts.bold;
  return style.italic ? fonts.italic : fonts.regular;
};

/**
 * Runs to words, each carrying the font it is set in.
 *
 * Whitespace is collapsed the way plain wrapping always collapsed it, but
 * whether a space existed *between two runs* has to be tracked deliberately:
 * `**bold**text` is one word and `**bold** text` is two, and the run texts
 * alone do not say which.
 */
function tokenize(runs, fonts) {
  const tokens = [];
  let space = false;

  for (const style of runs) {
    const text = sanitize(style.text);
    if (!text) continue;

    const font = fontFor(fonts, style);
    if (/^\s/.test(text)) space = true;

    const words = text.split(/\s+/).filter(Boolean);
    for (const word of words) {
      tokens.push({ text: word, font, space: space && tokens.length > 0 });
      space = true;
    }

    space = words.length ? /\s$/.test(text) : true;
  }

  return tokens;
}

/**
 * Fit words into `maxWidth`, measuring each in its own font.
 *
 * A single word wider than the column is split mid-word rather than allowed to
 * run past the edge -- long URLs in a description are the common case.
 */
function wrapTokens(tokens, size, maxWidth) {
  const lines = [];
  let segments = [];
  let width = 0;

  // Adjacent text in the same font is one segment, so a drawn line is as few
  // drawText calls as it can be and the kerning within a phrase is preserved.
  const push = (font, text) => {
    const last = segments.at(-1);
    if (last && last.font === font) last.text += text;
    else segments.push({ text, font, size });
  };

  const flush = () => {
    lines.push({ segments });
    segments = [];
    width = 0;
  };

  for (const token of tokens) {
    const lead = token.space && segments.length ? ' ' : '';
    const withLead = token.font.widthOfTextAtSize(lead + token.text, size);

    if (width + withLead <= maxWidth) {
      push(token.font, lead + token.text);
      width += withLead;
      continue;
    }

    if (segments.length) flush();

    const alone = token.font.widthOfTextAtSize(token.text, size);
    if (alone <= maxWidth) {
      push(token.font, token.text);
      width = alone;
      continue;
    }

    let chunk = '';
    for (const char of token.text) {
      if (chunk && token.font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
        push(token.font, chunk);
        flush();
        chunk = char;
      } else chunk += char;
    }
    if (chunk) {
      push(token.font, chunk);
      width = token.font.widthOfTextAtSize(chunk, size);
    }
  }

  if (segments.length) flush();
  return lines.length ? lines : [{ segments: [] }];
}

/** Blocks from src/lib/markup.js to lines, against a column of `maxWidth`. */
export function layoutBlocks(blocks, fonts, { maxWidth, size = SIZE.body, leading = LEADING.body } = {}) {
  const lines = [];
  const blank = () => ({ segments: [], indent: 0, size, leading });

  // The gap below a heading is the heading's, not the body's: body leading
  // under 11pt type leaves about four points between the heading's descender
  // and the next line's cap, which reads as a collision rather than a heading.
  let afterHeading = false;
  const opens = (i) => (i === 0 && afterHeading ? SUBHEAD.leading : leading);

  for (const block of blocks) {
    if (block.type === 'blank') {
      lines.push({ ...blank(), leading: opens(0) });
      afterHeading = false;
      continue;
    }

    if (block.type === 'heading') {
      const opening = lines.length === 0;
      const bolded = block.runs.map((r) => ({ ...r, bold: true }));
      wrapTokens(tokenize(bolded, fonts), SUBHEAD.size, maxWidth).forEach((line, i) => {
        lines.push({
          ...line,
          indent: 0,
          size: SUBHEAD.size,
          leading: SUBHEAD.leading + (i === 0 && !opening ? SUBHEAD.spaceAbove : 0),
        });
      });
      afterHeading = true;
      continue;
    }

    if (block.type === 'list') {
      // Every marker in a list is measured against the widest of them, so the
      // text starts at one x whether the list runs to item 9 or item 10.
      const markers = block.items.map((_, i) => (block.ordered ? `${block.start + i}.` : BULLET));
      const indent = LIST_GAP + Math.max(
        ...markers.map((m) => fonts.regular.widthOfTextAtSize(m, size)),
      );

      block.items.forEach((item, i) => {
        wrapTokens(tokenize(item.runs, fonts), size, maxWidth - indent).forEach((line, j) => {
          lines.push({
            ...line,
            indent,
            size,
            leading: i === 0 ? opens(j) : leading,
            ...(j === 0 ? { marker: { text: markers[i], font: fonts.regular, size } } : {}),
          });
        });
      });
      afterHeading = false;
      continue;
    }

    wrapTokens(tokenize(block.runs, fonts), size, maxWidth).forEach((line, i) => {
      lines.push({ ...line, indent: 0, size, leading: opens(i) });
    });
    afterHeading = false;
  }

  return lines.length ? lines : [blank()];
}

/**
 * Visual height of a block of lines: cap height of the first, the leading down
 * to each one after it, and the descender of the last.
 *
 * The first line's own `leading` is deliberately ignored -- it describes the
 * gap above a line that is no longer there, which is exactly what makes a
 * heading split onto a continuation page lose its extra space rather than
 * carry it to the top of the page.
 */
export const blockHeight = (lines) => (lines.length
  ? (METRICS.cap + METRICS.descender) * lines[0].size
    + lines.slice(1).reduce((sum, line) => sum + line.leading, 0)
  : 0);

export const rowHeight = (lines) =>
  Math.max(ROW.minHeight, blockHeight(lines) + 2 * ROW.padding);

/**
 * How many of `lines` fit in `height`.
 *
 * The closed-form inverse this replaces divided by one leading value, which
 * cannot survive lines of different heights. Zero when not even one fits.
 */
export function linesThatFit(lines, height) {
  let count = 0;
  while (count < lines.length && rowHeight(lines.slice(0, count + 1)) <= height) count += 1;
  return count;
}

/** Baseline of the first line, so the block sits centered in its box. */
export const firstBaselineY = (boxTop, boxHeight, lines) =>
  boxTop - (boxHeight - blockHeight(lines)) / 2 - METRICS.cap * lines[0].size;

/** Baseline of every line, given where the first one sits. */
export function baselines(firstY, lines) {
  let y = firstY;
  return lines.map((line, i) => {
    if (i) y -= line.leading;
    return y;
  });
}
