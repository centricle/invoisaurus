import express from 'express';
import {
  makeInvoice, validateInvoice, invoiceTotals,
  dueDateFor, today, TERMS, INVOICE_STATUSES, INVOICE_STYLES, styleId,
  withSnapshots, isOverdue, INVOICE_ID,
} from '../schema.js';
import { parseCents, parseQuantity } from '../money.js';
import { generateInvoicePdf } from '../lib/pdf/generate.js';
import { setFlash } from '../flash.js';

export const invoicesRouter = express.Router();

/**
 * Every `:id` on this router becomes a filename, so it is checked once here
 * rather than in each handler.
 *
 * Express percent-decodes route parameters, which means `%2e%2e%2f` would reach
 * a handler as `../` and walk out of the invoice directory. An id this app did
 * not write is not a record, so the answer is the 404 a missing invoice gets.
 */
invoicesRouter.param('id', (req, res, next, id) => {
  if (!INVOICE_ID.test(id)) return res.status(404).render('404', { what: 'Invoice' });
  next();
});

/**
 * Form fields to invoice-shaped data.
 *
 * Line items arrive as parallel arrays (`description[]`, `quantity[]`,
 * `rate[]`) rather than indexed keys, so adding and removing rows in the
 * browser never has to renumber anything. Rows that are entirely blank are
 * dropped: a trailing empty row is how a form looks, not something to bill.
 *
 * `text` normalizes line endings because a browser submits a textarea's value
 * with CRLF, and nothing downstream strips the carriage returns -- they would
 * be written to the record verbatim and read back into the editor. The PDF is
 * no help in catching that: its sanitize() drops a bare \r, so the document
 * looks right while the record does not. Stringifying first also keeps a
 * duplicated field name, which qs parses into an array, from throwing on
 * .trim().
 */
const text = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

function lineItemsFromForm(body) {
  const asArray = (v) => (v == null ? [] : [].concat(v));
  // qs parses the `name[]` form fields into plain array keys.
  const descriptions = asArray(body.description);
  const quantities = asArray(body.quantity);
  const rates = asArray(body.rate);

  return descriptions
    .map((description, i) => ({
      description: text(description),
      quantityMilli: parseQuantity(quantities[i]),
      rateCents: parseCents(rates[i]),
    }))
    .filter((li) => li.description || li.quantityMilli != null || li.rateCents != null);
}

const invoiceFromForm = (body) => ({
  vendorId: body.vendorId || '',
  clientId: body.clientId || '',
  issueDate: body.issueDate || today(),
  terms: body.terms || 'net30',
  dueDate: body.dueDate || dueDateFor(body.issueDate || today(), body.terms || 'net30'),
  status: body.status || 'draft',
  // Absent on an ordinary save. The style buttons are submit buttons, and a
  // form submits only the one that was clicked, so every other save arrives
  // with no style at all -- which is why both callers below fall back to the
  // stored value rather than to a default.
  style: body.style || '',
  notes: text(body.notes),
  lineItems: lineItemsFromForm(body),
});


/**
 * Everything the editor needs besides the record. The store is the request's:
 * whichever one the app mounted -- a directory, a visitor's memory, a tenant's
 * tables -- these handlers never import one and never find out.
 */
const renderContext = async (store, invoice, errors = []) => ({
  invoice,
  // The store hands back what is on disk, not a record through makeInvoice, so
  // an invoice written before styles existed carries no `style` key. The PDF
  // route survives that on styleFor's fallback; the toggle would compare every
  // button against undefined and light none of them. Resolve the fallback here
  // rather than in the template, so the view compares two real style ids.
  currentStyle: styleId(invoice.style),
  totals: invoiceTotals(invoice),
  clients: await store.listClients(),
  vendors: await store.listVendors(),
  TERMS,
  INVOICE_STATUSES,
  INVOICE_STYLES,
  errors,
});

invoicesRouter.get('/', async (req, res) => {
  const { store } = req;
  const clients = await store.listClients();
  const { client: clientFilter = '', status: statusFilter = '' } = req.query;

  // Files that would not parse are listed alongside the invoices rather than
  // thrown. They carry no client and no status, so no filter can describe one
  // and they are shown whatever the filter says -- a damaged file that only
  // appears under the right filter is a damaged file nobody finds.
  const { invoices: readable, unreadable } = await store.scanInvoices();

  const invoices = readable
    .filter((inv) => (!clientFilter || inv.clientId === clientFilter))
    .filter((inv) => (!statusFilter || inv.status === statusFilter))
    .map((inv) => ({
      ...inv,
      totalCents: invoiceTotals(inv).totalCents,
      client: clients.find((c) => c.id === inv.clientId) || null,
    }));

  // Outstanding is what you actually want to know from this screen: what has
  // been sent and not yet paid. Drafts are not money owed and voids never were.
  const outstandingCents = invoices
    .filter((inv) => inv.status === 'sent')
    .reduce((sum, inv) => sum + inv.totalCents, 0);

  res.render('invoices/index', {
    invoices, unreadable, clients, vendors: await store.listVendors(), INVOICE_STATUSES,
    clientFilter, statusFilter,
    outstandingCents,
    // Wrapped, not passed by reference: Array.filter supplies the index as the
    // second argument, which would land in isOverdue's `asOf` parameter and
    // silently compare a date string against a number.
    overdueCount: invoices.filter((inv) => isOverdue(inv)).length,
  });
});

/**
 * Step one is always choosing a client.
 *
 * Defaulting to the most recently used client is one distracted click away from
 * sending Client A's invoice to Client B, which is a phone call rather than a
 * keystroke to undo.
 */
invoicesRouter.get('/new', async (req, res) => {
  const { store } = req;
  const clients = await store.listClients();
  const vendors = await store.listVendors();
  const client = clients.find((c) => c.id === req.query.clientId);

  // No vendors is the same kind of dead end as no clients, and it arrives first
  // on a fresh install that skipped the seed. Without this the editor opened
  // with an empty "Issued by" dropdown and the only feedback was a 422 after
  // the whole form had been filled in.
  if (!vendors.length || !client) return res.render('invoices/pick-client', { clients, vendors });

  const invoice = makeInvoice({
    vendorId: req.query.vendorId || vendors[0]?.id || '',
    clientId: client.id,
    lineItems: [{ description: '', quantityMilli: null, rateCents: null }],
  });
  const seeded = withSnapshots(invoice, { vendor: await store.getVendor(invoice.vendorId), client });
  res.render('invoices/form', { ...await renderContext(store, seeded), isNew: true });
});

invoicesRouter.post('/', async (req, res) => {
  const { store } = req;
  const form = invoiceFromForm(req.body);
  const vendor = await store.getVendor(form.vendorId);
  const input = makeInvoice({
    ...form,
    style: form.style || vendor?.defaultStyle,
  });
  const client = await store.getClient(input.clientId);
  const errors = validateInvoice(input, { vendor, client });
  if (errors.length) {
    return res.status(422).render('invoices/form', { ...await renderContext(store, input, errors), isNew: true });
  }
  // The number is allocated here and not when the form opened, so abandoning a
  // draft does not burn a number out of the series. The snapshot is taken
  // first so the store writes a complete record in one step.
  const invoice = await store.createInvoice(withSnapshots(input, { vendor, client, force: true }));
  setFlash(res, 'invoice-created', invoice.id);
  res.redirect(`/invoices/${invoice.id}`);
});

/**
 * The PDF is the document. The editor previews it by pointing an iframe here
 * rather than rendering a second, HTML approximation that could drift from what
 * the client actually receives.
 */
invoicesRouter.get('/:id/pdf', async (req, res, next) => {
  const invoice = await req.store.getInvoice(req.params.id);
  if (!invoice) return res.status(404).render('404', { what: 'Invoice' });
  try {
    // A guest's PDF is really generated from their own records, watermarked
    // rather than withheld. A canned PDF would contradict the form they just
    // filled in, and the document is the half of this tool worth showing.
    // Whoever attached the store decides; see `watermark` in src/demo.js.
    const bytes = await generateInvoicePdf(invoice, { watermark: Boolean(res.locals.watermark) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${req.query.download == null ? 'inline' : 'attachment'}; filename="${invoice.id}.pdf"`,
    );
    // The editor previews this in an iframe. Hosted, the app is proxied under
    // a site that sends `X-Frame-Options: DENY` for every path, which blocks
    // framing even same-origin. Answering with a second X-Frame-Options would
    // make it worse: browsers resolve conflicting values to the most
    // restrictive. CSP frame-ancestors supersedes the older header in modern
    // browsers, so it settles the question from here rather than depending on
    // what the proxy passes through.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.end(Buffer.from(bytes));
  } catch (err) {
    next(err);
  }
});

invoicesRouter.get('/:id', async (req, res) => {
  const invoice = await req.store.getInvoice(req.params.id);
  if (!invoice) return res.status(404).render('404', { what: 'Invoice' });
  res.render('invoices/form', { ...await renderContext(req.store, invoice), isNew: false });
});

invoicesRouter.post('/:id', async (req, res) => {
  const { store } = req;
  const existing = await store.getInvoice(req.params.id);
  if (!existing) return res.status(404).render('404', { what: 'Invoice' });

  // The vendor is fixed at creation, so it is taken from the stored record and
  // never from the form. The client is still editable while the invoice is a
  // draft and is frozen once it leaves one. Both are carried by the snapshot
  // too, and the snapshot stops moving when the invoice is sent: taking either
  // from the body afterward would let a sent invoice claim a vendor whose
  // remit-from block it does not print and whose number series it is not in.
  const input = makeInvoice({
    ...invoiceFromForm(req.body),
    vendorId: existing.vendorId,
    clientId: existing.status === 'draft' ? (req.body.clientId || existing.clientId) : existing.clientId,
    // The style is frozen out of draft for the same reason the snapshots are:
    // the invoice the client already has was drawn one way, and re-rendering
    // it another way makes one invoice number into two different documents.
    style: existing.status === 'draft' ? (req.body.style || existing.style) : existing.style,
    id: existing.id,
    number: existing.number,
    createdAt: existing.createdAt,
    billTo: existing.billTo,
    remitFrom: existing.remitFrom,
  });
  const vendor = await store.getVendor(input.vendorId);
  const client = await store.getClient(input.clientId);
  const errors = validateInvoice(input, { vendor, client });
  if (errors.length) {
    return res.status(422).render('invoices/form', { ...await renderContext(store, input, errors), isNew: false });
  }
  await store.saveInvoice(withSnapshots(input, { vendor, client, storedStatus: existing.status }));
  setFlash(res, 'invoice-saved');
  res.redirect(`/invoices/${existing.id}`);
});

invoicesRouter.post('/:id/delete', async (req, res) => {
  const invoice = await req.store.getInvoice(req.params.id);
  if (!invoice) return res.status(404).render('404', { what: 'Invoice' });
  // The vendor counter is deliberately not rewound. A gap in the series is a
  // deleted draft; a reused number is an accounting problem.
  await req.store.deleteInvoice(invoice.id);
  setFlash(res, 'invoice-deleted', invoice.id);
  res.redirect('/invoices');
});

export { lineItemsFromForm, invoiceFromForm };
