/**
 * The formatting subset a description or a notes block may carry.
 *
 * Deliberately tiny, and deliberately not a Markdown parser. A parser that can
 * only recognize what the PDF can draw cannot parse something into a construct
 * that then has to be degraded or dropped -- and on an invoice, a document you
 * cannot take back, "what you typed is what prints" is worth more than breadth.
 * Anything outside the table below is literal text.
 *
 *   # Heading          one level, no more
 *   **bold**  __bold__
 *   *italic*  _italic_
 *   - item             bullet list
 *   1. item            numbered list, renumbered from the first number
 *   \*                 a literal asterisk
 *
 * Slack's mrkdwn was the other candidate and is the wrong shape: it is not an
 * open standard, it has no heading syntax, it has no list syntax for anything
 * but the message composer, and it spells bold with one asterisk. Two of the
 * four constructs above do not exist in it.
 *
 * Two divergences from CommonMark, both on purpose:
 *
 *   - **A line break is a line break.** CommonMark folds consecutive lines into
 *     one paragraph. Descriptions became multi-line in 1.1.1 with every break
 *     printing, and quietly joining those lines now would change documents that
 *     were already produced.
 *   - **`*` at the start of a line is emphasis, never a bullet.** `-` is the
 *     bullet. One spelling for one construct is what keeps a description from
 *     printing differently than it reads in the editor.
 *
 * Blocks are the only thing this module knows about. Where they sit on a page,
 * and in what font, is src/lib/pdf/richtext.js.
 */

/** A run of text in one style. `{ text, bold, italic }`. */
const run = (text, style) => ({ text, bold: Boolean(style.bold), italic: Boolean(style.italic) });

const HEADING = /^#[ \t]+(.*)$/;
const BULLET = /^-[ \t]+(.*)$/;
const ORDERED = /^(\d{1,3})\.[ \t]+(.*)$/;

/** Characters a backslash can turn back into themselves. */
const ESCAPABLE = new Set(['\\', '*', '_', '#', '-', '.']);

const isWord = (char) => char !== undefined && /\w/.test(char);
const isSpace = (char) => char === undefined || /\s/.test(char);

/**
 * The marker opening at `index`, or null.
 *
 * A marker for a style already in force does not open a second one, so
 * `**a**b**` is one bold run and two literal asterisks rather than a puzzle.
 * Single-character markers additionally may not open inside a word, which is
 * what keeps `snake_case_name` and `file_v2_final.pdf` out of italics.
 */
function openerAt(text, index, style) {
  const two = text.slice(index, index + 2);
  const one = text[index];

  if (!style.bold && (two === '**' || two === '__')) {
    return isSpace(text[index + 2]) ? null : two;
  }
  if (!style.italic && (one === '*' || one === '_')) {
    if (isWord(text[index - 1])) return null;
    return isSpace(text[index + 1]) ? null : one;
  }
  return null;
}

/**
 * Where `marker` closes, or -1.
 *
 * A closer may not follow whitespace, so `2 * 3 * 4` is arithmetic rather than
 * an italic 3. Returning -1 is not an error: the opener then stays in the text
 * as the character it is.
 */
function findCloser(text, from, marker) {
  for (let i = from; i <= text.length - marker.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text.slice(i, i + marker.length) !== marker) continue;
    if (isSpace(text[i - 1])) continue;
    if (marker.length === 1 && isWord(text[i + marker.length])) continue;
    if (i === from) continue;
    return i;
  }
  return -1;
}

/** One line of text to styled runs. */
function parseInline(text, style = {}) {
  const runs = [];
  let plain = '';

  const flush = () => {
    if (plain) runs.push(run(plain, style));
    plain = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '\\' && ESCAPABLE.has(text[i + 1])) {
      plain += text[i + 1];
      i += 1;
      continue;
    }

    const marker = openerAt(text, i, style);
    if (marker) {
      const close = findCloser(text, i + marker.length, marker);
      if (close !== -1) {
        flush();
        const inner = text.slice(i + marker.length, close);
        const nested = marker.length === 2
          ? { ...style, bold: true }
          : { ...style, italic: true };
        runs.push(...parseInline(inner, nested));
        i = close + marker.length - 1;
        continue;
      }
    }

    plain += char;
  }

  flush();
  return runs.length ? runs : [run('', style)];
}

/** Strip the escapes without interpreting anything else. */
function literalRuns(text) {
  return [run(text, {})];
}

function toBlocks(text, inline) {
  const blocks = [];
  let list = null;

  const endList = () => { list = null; };

  const item = (ordered, start, content) => {
    if (!list || list.ordered !== ordered) {
      list = { type: 'list', ordered, start, items: [] };
      blocks.push(list);
    }
    list.items.push({ runs: inline(content) });
  };

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) {
      endList();
      blocks.push({ type: 'blank' });
      continue;
    }

    if (inline === literalRuns) {
      endList();
      blocks.push({ type: 'paragraph', runs: inline(line) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endList();
      blocks.push({ type: 'heading', runs: inline(heading[1]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) { item(false, 1, bullet[1]); continue; }

    const ordered = ORDERED.exec(line);
    if (ordered) { item(true, Number(ordered[1]), ordered[2]); continue; }

    endList();
    blocks.push({ type: 'paragraph', runs: inline(line) });
  }

  // A trailing blank contributes nothing but height.
  while (blocks.at(-1)?.type === 'blank') blocks.pop();
  return blocks;
}

/** Text written since the formatting subset existed. */
export const parseMarkup = (text) => toBlocks(text, parseInline);

/**
 * Text written before it did.
 *
 * Every line is a paragraph and every character is itself, so an invoice issued
 * when `*` meant an asterisk still prints an asterisk. Same block shape as
 * `parseMarkup`, so nothing downstream has to know which one ran.
 */
export const parsePlain = (text) => toBlocks(text, literalRuns);
