import express from 'express';
import {
  listClients, getClient, createClient, updateClient, invoiceCountForClient,
} from '../store.js';
import { makeClient, validateClient, CLIENT_TYPES, emptyAddress } from '../schema.js';

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

clientsRouter.get('/', (req, res) => {
  const clients = listClients()
    .map((c) => ({ ...c, invoiceCount: invoiceCountForClient(c.id) }))
    .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
  res.render('clients/index', { clients });
});

clientsRouter.get('/new', (req, res) => {
  res.render('clients/form', {
    client: { ...makeClient({}), address: emptyAddress() },
    isNew: true, errors: [], CLIENT_TYPES, invoiceCount: 0,
  });
});

clientsRouter.post('/', (req, res) => {
  const input = fromForm(req.body);
  const errors = validateClient(input);
  if (errors.length) {
    return res.status(422).render('clients/form', {
      client: input, isNew: true, errors, CLIENT_TYPES, invoiceCount: 0,
    });
  }
  const client = createClient(input);
  res.redirect(`/clients/${client.id}/edit`);
});

clientsRouter.get('/:id/edit', (req, res) => {
  const client = getClient(req.params.id);
  if (!client) return res.status(404).render('404', { what: 'Client' });
  res.render('clients/form', {
    client, isNew: false, errors: [], CLIENT_TYPES,
    invoiceCount: invoiceCountForClient(client.id),
  });
});

clientsRouter.post('/:id', (req, res) => {
  const existing = getClient(req.params.id);
  if (!existing) return res.status(404).render('404', { what: 'Client' });
  // fromForm never reads an id from the request, so this can only ever be the
  // existing one. It is carried for the re-render on validation failure; the
  // write path takes the id as its own argument and ignores this field.
  const input = { ...fromForm(req.body), id: existing.id };
  const errors = validateClient(input);
  if (errors.length) {
    return res.status(422).render('clients/form', {
      client: input, isNew: false, errors, CLIENT_TYPES,
      invoiceCount: invoiceCountForClient(existing.id),
    });
  }
  updateClient(existing.id, input);
  res.redirect('/clients');
});
