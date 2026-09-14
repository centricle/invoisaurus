/**
 * The drawers, by id.
 *
 * The list of styles a *record* may carry lives in schema.js, beside the
 * statuses and the terms, and this is the list of styles that can actually be
 * drawn. They are deliberately two lists in two files: classic.js needs
 * addressLines and termById from schema.js, so a schema.js that imported this
 * back would close the cycle -- and it would drag pdf-lib into every route and
 * every test that touches a record. A test asserts the two agree.
 *
 * Named exports, not defaults, and that is load-bearing. Netlify's bundler
 * transpiles the tree to CommonJS and resolves a default import of a local
 * module in "node compatibility mode": the whole module namespace lands under
 * `.default`, so `classic` arrived as `{ default: { embedFonts, ... } }` and
 * every PDF in the deployed demo was a 500 reading `style.embedFonts is not a
 * function`. The suite cannot see it, because nothing here is bundled under
 * test. The same trap took out sausaging's airport table on 2026-09-10. A
 * test in test/styles.test.js refuses any local default export for this reason.
 */
import { classic } from './classic.js';
import { modern } from './modern.js';

export const STYLES = { classic, modern };

/**
 * The drawer for a style id, falling back to classic.
 *
 * An invoice written before this existed has no `style` at all, and a
 * hand-edited one can say anything. Neither is worth a 500 on the route that
 * renders the document someone is trying to get paid for. Same posture as
 * isInvoiceShaped in store.js: render what you can.
 */
export const styleFor = (id) => STYLES[id] ?? classic;
