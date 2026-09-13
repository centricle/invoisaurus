import express from 'express';
import { listVendors, getVendor, createVendor, updateVendor } from '../store.js';
import { makeVendor, validateVendor, emptyAddress } from '../schema.js';
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

vendorsRouter.get('/', (req, res) => {
  res.render('vendors/index', { vendors: listVendors() });
});

vendorsRouter.get('/new', (req, res) => {
  res.render('vendors/form', {
    vendor: { ...makeVendor({}), address: emptyAddress() }, isNew: true, errors: [],
  });
});

vendorsRouter.post('/', (req, res) => {
  const input = fromForm(req.body);
  const errors = validateVendor(input, { takenPrefixes: listVendors().map((v) => v.numberPrefix) });
  if (errors.length) return res.status(422).render('vendors/form', { vendor: input, isNew: true, errors });
  const vendor = createVendor(input);
  setFlash(res, 'vendor-created', vendor.name);
  res.redirect(`/vendors/${vendor.id}/edit`);
});

vendorsRouter.get('/:id/edit', (req, res) => {
  const vendor = getVendor(req.params.id);
  if (!vendor) return res.status(404).render('404', { what: 'Vendor' });
  res.render('vendors/form', { vendor, isNew: false, errors: [] });
});

vendorsRouter.post('/:id', (req, res) => {
  const existing = getVendor(req.params.id);
  if (!existing) return res.status(404).render('404', { what: 'Vendor' });
  // fromForm never reads an id from the request, so this can only ever be the
  // existing one. It is carried for the re-render on validation failure; the
  // write path takes the id as its own argument and ignores this field.
  const input = { ...fromForm(req.body), id: existing.id };
  const errors = validateVendor(input, {
    existing,
    // Every prefix but this vendor's own -- an edit that leaves the prefix
    // alone must not collide with itself.
    takenPrefixes: listVendors().filter((v) => v.id !== existing.id).map((v) => v.numberPrefix),
  });
  if (errors.length) return res.status(422).render('vendors/form', { vendor: input, isNew: false, errors });
  updateVendor(existing.id, input);
  setFlash(res, 'vendor-saved');
  res.redirect('/vendors');
});
