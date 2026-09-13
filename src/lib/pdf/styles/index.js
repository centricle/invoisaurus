/**
 * The drawers, by id.
 *
 * The list of styles a *record* may carry lives in schema.js, beside the
 * statuses and the terms, and this is the list of styles that can actually be
 * drawn. They are deliberately two lists in two files: classic.js needs
 * addressLines and termById from schema.js, so a schema.js that imported this
 * back would close the cycle -- and it would drag pdf-lib into every route and
 * every test that touches a record. A test asserts the two agree.
 */
import classic from './classic.js';

export const STYLES = { classic };

/**
 * The drawer for a style id, falling back to classic.
 *
 * An invoice written before this existed has no `style` at all, and a
 * hand-edited one can say anything. Neither is worth a 500 on the route that
 * renders the document someone is trying to get paid for. Same posture as
 * isInvoiceShaped in store.js: render what you can.
 */
export const styleFor = (id) => STYLES[id] ?? classic;
