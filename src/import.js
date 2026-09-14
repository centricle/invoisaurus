/**
 * Line items from CSV.
 *
 * A spreadsheet or a timesheet export is usually where the hours already are,
 * and retyping a dozen descriptions into the editor is where a transposed rate
 * gets in. This turns a CSV into the `lineItems` array an invoice holds, and
 * nothing more: which vendor, which client, what date, and whether the result
 * is a valid invoice are the caller's questions, answered by `validateInvoice`
 * in src/schema.js exactly as they are for a form post. Two checks of the same
 * rule would eventually disagree about it.
 *
 * No file access here, so the same code serves a command-line import and an
 * upload handler.
 *
 * Expected shape, one row per line item, header required:
 *
 *   description,quantity,rate
 *   "**Design review**
 *   Two rounds of comments on the mockups.",3.5,125.00
 */
import { parseQuantity, parseCents } from './money.js';

/**
 * Parse CSV text into rows of strings, per RFC 4180.
 *
 * Written out rather than split on commas and newlines because the useful
 * descriptions are exactly the ones that break that: a comma in the prose, a
 * second line under a bold heading, a quoted phrase. In CSV all three live
 * inside a quoted field, where a doubled `""` stands for one quote and a line
 * break is part of the value rather than the end of the row.
 *
 * Throws on a quote that is never closed. The alternative is reading the rest
 * of the file as one enormous description, which then validates fine.
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let quoteLine = 0;
  let line = 1;

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (quoted) {
      if (char === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else {
        if (char === '\n') line += 1;
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
      quoteLine = line;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line += 1;
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error(`Unclosed quote starting on line ${quoteLine}.`);
  // A file ending in a newline has already pushed its last row; one that does
  // not has a final row still in hand.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Header names a column may go by, lowercased. */
const COLUMNS = {
  description: ['description'],
  quantity: ['quantity', 'qty'],
  rate: ['rate'],
};

/**
 * Turn CSV text into line items: `{ lineItems, errors }`.
 *
 * Quantity and rate go through the same parsers the editor's form uses, so a
 * CSV accepts what the form accepts (`$1,250.00`, `7.5`) and rejects what it
 * rejects. An unparseable value is reported rather than stored as null, with
 * the row it came from, because "Line 4 needs a rate" means nothing to someone
 * looking at a spreadsheet with a header row and blank rows in it.
 *
 * Rows that are entirely blank are skipped. Columns other than the three are
 * ignored, so an export with a date or a project column imports as is.
 */
export function lineItemsFromCsv(text) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (err) {
    return { lineItems: [], errors: [err.message] };
  }

  const [header = [], ...body] = rows;
  const names = header.map((h) => h.trim().toLowerCase());
  const index = {};
  const errors = [];
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    index[key] = names.findIndex((n) => aliases.includes(n));
    if (index[key] === -1) errors.push(`No "${aliases[0]}" column in the header row.`);
  }
  if (errors.length) return { lineItems: [], errors };

  const lineItems = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    // Row 1 is the header, so the first data row is row 2: the number a
    // spreadsheet shows beside it.
    const rowNumber = i + 2;
    const cell = (key) => cells[index[key]] ?? '';
    const description = cell('description').replace(/\r\n?/g, '\n').trim();
    const quantityMilli = parseQuantity(cell('quantity'));
    const rateCents = parseCents(cell('rate'));
    if (!description) errors.push(`Row ${rowNumber} has no description.`);
    if (quantityMilli == null) errors.push(`Row ${rowNumber}: "${cell('quantity')}" is not a quantity.`);
    if (rateCents == null) errors.push(`Row ${rowNumber}: "${cell('rate')}" is not a rate.`);
    lineItems.push({ description, quantityMilli, rateCents });
  });

  if (!lineItems.length && !errors.length) errors.push('No line items below the header row.');
  return { lineItems, errors };
}
