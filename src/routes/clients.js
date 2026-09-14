import express from 'express';
import { makeClient, validateClient, CLIENT_TYPES, emptyAddress } from '../schema.js';
import { setFlash } from '../flash.js';

export const clientsRouter = express.Router();

/** Form fields to a client-shaped object, without touching the store. */
const fromForm = (body) => ({
  name: (body.name || '').trim(),
  displayName: (body.displayName || '').trim(),
  type: body.type,
  contactName: (body.contactName || '').trim(),
  address: {
    street: (body.street || '').trim(),
    street2: (body.street2 || '').trim(),
    city: (body.city || '').trim(),
    state: (body.state || '').trim().toUpperCase(),
    zip: (body.zip || '').trim(),
  },
});

clientsRouter.get('/', async (req, res) => {
  const { store } = req;
  // One pass over the invoices, not one per client: the count is derived from
  // the same list for every row.
  const invoices = await store.listInvoices();
  const clients = (await store.listClients())
    .map((c) => ({ ...c, invoiceCount: invoices.filter((inv) => inv.clientId === c.id).length }))
    .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
  res.render('clients/index', { clients });
});

clientsRouter.get('/new', (req, res) => {
  res.render('clients/form', {
    client: { ...makeClient({}), address: emptyAddress() },
    isNew: true, errors: [], CLIENT_TYPES, invoiceCount: 0,
  });
});

clientsRouter.post('/', async (req, res) => {
  const input = fromForm(req.body);
  const errors = validateClient(input);
  if (errors.length) {
    return res.status(422).render('clients/form', {
      client: input, isNew: true, errors, CLIENT_TYPES, invoiceCount: 0,
    });
  }
  const client = await req.store.createClient(input);
  setFlash(res, 'client-created', client.name);
  res.redirect(`/clients/${client.id}/edit`);
});

clientsRouter.get('/:id/edit', async (req, res) => {
  const client = await req.store.getClient(req.params.id);
  if (!client) return res.status(404).render('404', { what: 'Client' });
  res.render('clients/form', {
    client, isNew: false, errors: [], CLIENT_TYPES,
    invoiceCount: await req.store.invoiceCountForClient(client.id),
  });
});

clientsRouter.post('/:id', async (req, res) => {
  const { store } = req;
  const existing = await store.getClient(req.params.id);
  if (!existing) return res.status(404).render('404', { what: 'Client' });
  // fromForm never reads an id from the request, so this can only ever be the
  // existing one. It is carried for the re-render on validation failure; the
  // write path takes the id as its own argument and ignores this field.
  const input = { ...fromForm(req.body), id: existing.id };
  const errors = validateClient(input);
  if (errors.length) {
    return res.status(422).render('clients/form', {
      client: input, isNew: false, errors, CLIENT_TYPES,
      invoiceCount: await store.invoiceCountForClient(existing.id),
    });
  }
  await store.updateClient(existing.id, input);
  setFlash(res, 'client-saved');
  res.redirect('/clients');
});
