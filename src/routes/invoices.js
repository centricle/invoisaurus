import express from 'express';
import {
  scanInvoices, getInvoice, saveInvoice, deleteInvoice, allocateInvoiceNumber,
  listClients, getClient, listVendors, getVendor,
} from '../store.js';
import {
  makeInvoice, validateInvoice, invoiceTotals,
  dueDateFor, today, TERMS, INVOICE_STATUSES, withSnapshots, isOverdue, INVOICE_ID,
} from '../schema.js';
import { parseCents, parseQuantity } from '../money.js';
import { generateInvoicePdf } from '../lib/pdf/generate.js';
import { setFlash } from '../flash.js';
import { DEMO_MODE } from '../config.js';

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
 */
function lineItemsFromForm(body) {
  const asArray = (v) => (v == null ? [] : [].concat(v));
  // qs parses the `name[]` form fields into plain array keys.
  const descriptions = asArray(body.description);
  const quantities = asArray(body.quantity);
  const rates = asArray(body.rate);

  return descriptions
    .map((description, i) => ({
      description: String(description || '').trim(),
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
  notes: (body.notes || '').trim(),
  lineItems: lineItemsFromForm(body),
});


const renderContext = (invoice, errors = []) => ({
  invoice,
  totals: invoiceTotals(invoice),
  clients: listClients(),
  vendors: listVendors(),
  TERMS,
  INVOICE_STATUSES,
  errors,
});

invoicesRouter.get('/', (req, res) => {
  const clients = listClients();
  const { client: clientFilter = '', status: statusFilter = '' } = req.query;

  // Files that would not parse are listed alongside the invoices rather than
  // thrown. They carry no client and no status, so no filter can describe one
  // and they are shown whatever the filter says -- a damaged file that only
  // appears under the right filter is a damaged file nobody finds.
  const { invoices: readable, unreadable } = scanInvoices();

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
    invoices, unreadable, clients, vendors: listVendors(), INVOICE_STATUSES,
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
invoicesRouter.get('/new', (req, res) => {
  const clients = listClients();
  const vendors = listVendors();
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
  const seeded = withSnapshots(invoice, { vendor: getVendor(invoice.vendorId), client });
  res.render('invoices/form', { ...renderContext(seeded), isNew: true });
});

invoicesRouter.post('/', (req, res) => {
  const input = makeInvoice(invoiceFromForm(req.body));
  const errors = validateInvoice(input, {
    vendor: getVendor(input.vendorId), client: getClient(input.clientId),
  });
  if (errors.length) {
    return res.status(422).render('invoices/form', { ...renderContext(input, errors), isNew: true });
  }
  // The number is allocated here and not when the form opened, so abandoning a
  // draft does not burn a number out of the series.
  const { number, id } = allocateInvoiceNumber(input.vendorId);
  const invoice = saveInvoice(withSnapshots({ ...input, id, number }, {
    vendor: getVendor(input.vendorId), client: getClient(input.clientId), force: true,
  }), { create: true });
  setFlash(res, 'invoice-created', invoice.id);
  res.redirect(`/invoices/${invoice.id}`);
});

/**
 * The PDF is the document. The editor previews it by pointing an iframe here
 * rather than rendering a second, HTML approximation that could drift from what
 * the client actually receives.
 */
invoicesRouter.get('/:id/pdf', async (req, res, next) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).render('404', { what: 'Invoice' });
  try {
    // Really generated from this visitor's own records, watermarked rather
    // than withheld. A canned PDF would contradict the form they just filled
    // in, and the document is the half of this tool worth showing.
    const bytes = await generateInvoicePdf(invoice, { watermark: DEMO_MODE });
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

invoicesRouter.get('/:id', (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).render('404', { what: 'Invoice' });
  res.render('invoices/form', { ...renderContext(invoice), isNew: false });
});

invoicesRouter.post('/:id', (req, res) => {
  const existing = getInvoice(req.params.id);
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
    id: existing.id,
    number: existing.number,
    createdAt: existing.createdAt,
    billTo: existing.billTo,
    remitFrom: existing.remitFrom,
  });
  const errors = validateInvoice(input, {
    vendor: getVendor(input.vendorId), client: getClient(input.clientId),
  });
  if (errors.length) {
    return res.status(422).render('invoices/form', { ...renderContext(input, errors), isNew: false });
  }
  saveInvoice(withSnapshots(input, {
    vendor: getVendor(input.vendorId), client: getClient(input.clientId), storedStatus: existing.status,
  }));
  setFlash(res, 'invoice-saved');
  res.redirect(`/invoices/${existing.id}`);
});

invoicesRouter.post('/:id/delete', (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).render('404', { what: 'Invoice' });
  // The vendor counter is deliberately not rewound. A gap in the series is a
  // deleted draft; a reused number is an accounting problem.
  deleteInvoice(invoice.id);
  setFlash(res, 'invoice-deleted', invoice.id);
  res.redirect('/invoices');
});

export { lineItemsFromForm, invoiceFromForm };
