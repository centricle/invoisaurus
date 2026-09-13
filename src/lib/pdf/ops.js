/**
 * Named draw operations.
 *
 * A builder returns a list of these plus the y coordinate it promises the next
 * block may start at. It never touches the page. That separation is what the
 * two-pass structure in generate.js exists to protect: the header height and
 * the space reserved for the header disagreed once, and rows went below the
 * bottom margin.
 *
 * Text was the only kind of operation there was, because the one layout drew
 * nothing else -- its rules were painted by the page loop rather than carried
 * in the list. A header that wants a rule under the masthead, a bordered
 * summary panel, or a filled band behind the column headings has to be able to
 * put them in the list too, or it has to draw itself, and then it is measuring
 * and drawing in the same breath again.
 */
import { SIZE, METRICS, sanitize } from './layout.js';

/** Text, left-anchored at `x` or right-anchored at `right`. */
export const text = (string, opts) => ({ kind: 'text', string, ...opts });

/** A horizontal rule at `y`, from `x` to `right`. */
export const rule = (opts) => ({ kind: 'rule', thickness: 0.75, ...opts });

/** A rectangle, anchored bottom-left the way pdf-lib anchors one. */
export const box = (opts) => ({ kind: 'box', ...opts });

/**
 * The lowest y at which these operations put ink.
 *
 * A builder's `endY` is a promise about where it stopped. Nothing enforced it,
 * and a style that computed `endY` one way and drew something below it would
 * reproduce the header bug exactly. With this, a test can hold a style to its
 * own claim in one line.
 */
export const lowestInk = (ops) => Math.min(...ops.map(bottom));

/** Text hangs below its baseline; a rule and a box are drawn at their y. */
const bottom = (op) => (op.kind === 'text'
  ? op.y - METRICS.descender * (op.size ?? SIZE.body)
  : op.y);

/**
 * Paint one operation.
 *
 * `font` and `ink` are the defaults an operation may omit, so a style states
 * only what it is changing. `sanitize` is applied here rather than by the
 * builder, so it cannot be forgotten: it is the reason the standard fonts
 * never meet a character they throw on.
 */
export function render(page, op, { font, ink }) {
  if (op.kind === 'rule') {
    return page.drawLine({
      start: { x: op.x, y: op.y },
      end: { x: op.right, y: op.y },
      thickness: op.thickness,
      color: op.color ?? ink,
    });
  }

  if (op.kind === 'box') {
    return page.drawRectangle({
      x: op.x,
      y: op.y,
      width: op.width,
      height: op.height,
      color: op.fill,
      borderColor: op.border,
      borderWidth: op.borderWidth ?? 0,
    });
  }

  const string = sanitize(op.string);
  const size = op.size ?? SIZE.body;
  const face = op.font ?? font;
  const x = op.right != null ? op.right - face.widthOfTextAtSize(string, size) : op.x;
  return page.drawText(string, { x, y: op.y, size, font: face, color: op.color ?? ink });
}
