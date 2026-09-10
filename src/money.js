/**
 * All money is integer cents and all quantities are integer thousandths.
 *
 * JavaScript stores every number as a binary float, and most decimal fractions
 * have no exact binary representation: `0.1 + 0.2` is `0.30000000000000004`,
 * not `0.3`. The error is invisible in one operation and compounds across a
 * column of line items, which is how a total ends up a cent away from the
 * figure a client checks by hand.
 *
 * Integers avoid it outright. Values are parsed into integers at the input
 * boundary and formatted back to strings at the render boundary. One step in
 * between is not integer-only, and it is worth naming rather than glossing.
 * A line amount is quantity (thousandths) times rate (cents), and that product
 * has to come back down by a factor of 1000 to land in cents again. The
 * multiply is exact, because the product stays far below 2^53 where every
 * integer is still representable. The divide is not, so its result is rounded
 * on the spot. Nothing fractional survives that line, and nothing fractional
 * is ever stored.
 */

const CENTS = 100;
const MILLI = 1000;

/** Round half away from zero, which is what invoices and humans both expect. */
function roundHalfUp(n) {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/**
 * Parse a user-entered decimal into an integer at `scale` (100 = cents).
 * Tolerates "$", thousands separators, and surrounding whitespace.
 * Returns null for anything that is not a number, so callers can distinguish
 * "empty" from "zero" rather than silently billing $0.00.
 */
export function parseScaled(input, scale) {
  if (input == null) return null;
  const raw = String(input).trim().replace(/[$,\s]/g, '');
  // At least one digit is required on one side of the point. A pattern of
  // `\d*\.?\d*` matches "", ".", "-" and "-." as well, and the first three were
  // caught by hand while "-." fell through to `Number("") * scale` and returned
  // -0 -- a rate that then passed every "is it missing" check and billed $0.00.
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return null;

  const negative = raw.startsWith('-');
  const [whole = '0', frac = ''] = raw.replace(/^-/, '').split('.');
  const digits = String(scale).length - 1;

  // Pad or truncate the fraction to the scale, rounding on the first dropped
  // digit rather than truncating toward zero.
  const kept = frac.slice(0, digits).padEnd(digits, '0');
  const next = frac[digits];
  let value = Number(whole) * scale + Number(kept || '0');
  if (next && Number(next) >= 5) value += 1;

  // Past 2^53 a "number" is no longer an exact integer, so the whole
  // integer-only premise of this module quietly stops holding: the value is a
  // float again, arithmetic on it is approximate, and `JSON.stringify` writes
  // it as `1e+23` -- which parses back as a different number than any invoice
  // ever contained. Holding a digit key down in the rate field is enough to
  // reach it, so this is an ordinary typo, not an attack. Reject rather than
  // clamp: a silently capped rate is a wrong invoice that looks right.
  if (!Number.isSafeInteger(value)) return null;

  return negative ? -value : value;
}

/**
 * The largest line amount or total this app will accept, in cents: $1 billion.
 *
 * `parseScaled` already refuses anything outside safe-integer range, which is
 * the correctness floor -- past it a "number" stops being an exact integer and
 * the premise at the top of this file collapses. This is a second, much lower
 * ceiling, and it exists for a different reason: safe-integer range tops out
 * near ninety trillion dollars, so a rate that is nine orders of magnitude too
 * large still parses cleanly and produces an invoice that merely looks wrong.
 * A bound a human would recognize as absurd turns that into an error message.
 *
 * It also keeps `lineAmountCents` honest. Its multiply is exact only below
 * 2^53, and quantity x rate can cross that line while both operands are
 * individually fine, so the product is what has to be checked, not the inputs.
 */
export const MAX_CENTS = 100_000_000_000;

export const parseCents = (input) => parseScaled(input, CENTS);
export const parseQuantity = (input) => parseScaled(input, MILLI);

/**
 * Line amount in cents: quantity (thousandths) x rate (cents), divided back
 * down and rounded. The divide is the one fractional step in this module; see
 * the note at the top for why rounding it here is enough.
 */
export function lineAmountCents(quantityMilli, rateCents) {
  if (quantityMilli == null || rateCents == null) return 0;
  return roundHalfUp((quantityMilli * rateCents) / MILLI);
}

function formatScaled(value, scale, { trimZeros = false } = {}) {
  if (value == null) return '';
  const digits = String(scale).length - 1;
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / scale);
  let frac = String(abs % scale).padStart(digits, '0');
  if (trimZeros) frac = frac.replace(/0+$/, '');
  const grouped = whole.toLocaleString('en-US');
  const out = frac ? `${grouped}.${frac}` : grouped;
  return negative ? `-${out}` : out;
}

/** "187500" -> "1,875.00" */
export const formatCents = (cents) => formatScaled(cents, CENTS);

/** "187500" -> "$1,875.00" */
export const formatUSD = (cents) => (cents == null ? '' : `${cents < 0 ? '-' : ''}$${formatCents(Math.abs(cents))}`);

/** "12500" -> "12.5" — quantities read better without trailing zeros. */
export const formatQuantity = (milli) => formatScaled(milli, MILLI, { trimZeros: true });

export const sumCents = (values) => values.reduce((total, n) => total + (n || 0), 0);

/**
 * Values destined for a form field, never for display.
 *
 * `formatCents`/`formatQuantity` group thousands with commas, which is right on
 * a page and wrong in an input. An `<input type="number">` treats "9,999" as
 * invalid and renders it as *blank* — no error, no warning — and submitting
 * that blank field writes the value back as null. A grouped separator in a form
 * control is therefore a data-loss bug, not a cosmetic one.
 *
 * Anything placed in a form control goes through these.
 */
const unformatted = (value, scale) => {
  if (value == null) return '';
  const negative = value < 0;
  const abs = Math.abs(value);
  const digits = String(scale).length - 1;
  const frac = String(abs % scale).padStart(digits, '0');
  return `${negative ? '-' : ''}${Math.floor(abs / scale)}.${frac}`;
};

/** "9999000" -> "9999" (no separators, no trailing zeros). */
export const quantityInputValue = (milli) =>
  (milli == null ? '' : unformatted(milli, 1000).replace(/\.?0+$/, ''));

/** "150000" -> "1500.00" (no separators). */
export const centsInputValue = (cents) => unformatted(cents, 100);
