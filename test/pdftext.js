/**
 * Pull the drawn strings back out of a generated PDF.
 *
 * Everything else in pdf.test.js asserts on geometry: page counts, row heights,
 * where a column edge sits. None of that can tell whether the amount column got
 * a formatted dollar figure or a raw integer number of cents, because both draw
 * identically as far as the layout is concerned. Reading the text back is the
 * only way to assert that what the client receives says $1,875.00.
 *
 * pdf-lib compresses its content streams, and draws text as hex string literals
 * rather than as readable text, so both have to be undone: inflate every stream
 * in the file, then decode each `<hex> Tj` operand. Strings are returned in
 * draw order, which is also reading order for this document.
 */
import zlib from 'node:zlib';

export function pdfStrings(bytes) {
  const buf = Buffer.from(bytes);

  let content = '';
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let start = i + 'stream'.length;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    try {
      content += zlib.inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      // Not a deflated stream (fonts, metadata). Nothing drawn in it.
    }
    i = end + 'endstream'.length;
  }

  return [...content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'));
}

/** The whole document as one string, for a plain "does it say this" check. */
export const pdfText = (bytes) => pdfStrings(bytes).join('\n');
