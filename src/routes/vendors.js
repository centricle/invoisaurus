import express from 'express';
import { makeVendor, validateVendor, emptyAddress, INVOICE_STYLES } from '../schema.js';
import { setFlash } from '../flash.js';

export const vendorsRouter = express.Router();

const fromForm = (body) => ({
  name: (body.name || '').trim(),
  email: (body.email || '').trim(),
  numberPrefix: (body.numberPrefix || '').trim(),
  defaultStyle: body.defaultStyle,
  numberPad: Number(body.numberPad),
  nextNumber: Number(body.nextNumber),
  address: {
    street: (body.street || '').trim(),
    street2: (body.street2 || '').trim(),
    city: (body.city || '').trim(),
    state: (body.state || '').trim().toUpperCase(),
    zip: (body.zip || '').trim(),
  },
});

vendorsRouter.get('/', async (req, res) => {
  res.render('vendors/index', { vendors: await req.store.listVendors() });
});

vendorsRouter.get('/new', (req, res) => {
  res.render('vendors/form', {
    vendor: { ...makeVendor({}), address: emptyAddress() }, isNew: true, errors: [], INVOICE_STYLES,
  });
});

vendorsRouter.post('/', async (req, res) => {
  const { store } = req;
  const input = fromForm(req.body);
  const errors = validateVendor(input, {
    takenPrefixes: (await store.listVendors()).map((v) => v.numberPrefix),
  });
  if (errors.length) {
    return res.status(422).render('vendors/form', { vendor: input, isNew: true, errors, INVOICE_STYLES });
  }
  const vendor = await store.createVendor(input);
  setFlash(res, 'vendor-created', vendor.name);
  res.redirect(`/vendors/${vendor.id}/edit`);
});

vendorsRouter.get('/:id/edit', async (req, res) => {
  const vendor = await req.store.getVendor(req.params.id);
  if (!vendor) return res.status(404).render('404', { what: 'Vendor' });
  res.render('vendors/form', { vendor, isNew: false, errors: [], INVOICE_STYLES });
});

vendorsRouter.post('/:id', async (req, res) => {
  const { store } = req;
  const existing = await store.getVendor(req.params.id);
  if (!existing) return res.status(404).render('404', { what: 'Vendor' });
  // fromForm never reads an id from the request, so this can only ever be the
  // existing one. It is carried for the re-render on validation failure; the
  // write path takes the id as its own argument and ignores this field.
  const input = { ...fromForm(req.body), id: existing.id };
  const errors = validateVendor(input, {
    existing,
    // Every prefix but this vendor's own -- an edit that leaves the prefix
    // alone must not collide with itself.
    takenPrefixes: (await store.listVendors()).filter((v) => v.id !== existing.id).map((v) => v.numberPrefix),
  });
  if (errors.length) {
    return res.status(422).render('vendors/form', { vendor: input, isNew: false, errors, INVOICE_STYLES });
  }
  await store.updateVendor(existing.id, input);
  setFlash(res, 'vendor-saved');
  res.redirect('/vendors');
});
