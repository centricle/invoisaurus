/**
 * Populate a store with the ACME cast, the way the hosted demo sees it.
 *
 * Runs the real store methods rather than hand-assembling JSON, so the seeded
 * records are created by the same code paths a visitor's own records will be
 * -- ids derived the same way, numbers allocated from the same counter,
 * snapshots frozen by the same policy. A hand-built fixture is how a demo
 * ends up containing records the app itself could not have produced.
 *
 * Any store that answers the contract can be seeded: a visitor's memory, a
 * scratch directory, a tenant's tables. `scripts/seed.mjs` is deliberately not
 * a caller -- it writes one sample draft into a real data directory, where
 * five invoices would be cleanup rather than a sample.
 */
import { makeInvoice, withSnapshots, today, addDays } from './schema.js';
import { parseQuantity, parseCents } from './money.js';
import { VENDOR, CLIENT, DEMO_CLIENTS, DEMO_INVOICES } from './fixtures/acme.js';

export async function seedDemoStore(store) {
  await store.ensureDataDir();
  const vendor = await store.createVendor(VENDOR);
  const clients = new Map();
  for (const record of [CLIENT, ...DEMO_CLIENTS]) {
    const created = await store.createClient(record);
    clients.set(created.id, created);
  }

  for (const spec of DEMO_INVOICES) {
    const client = clients.get(spec.client);
    if (!client) continue;

    const issueDate = addDays(today(), -spec.issuedDaysAgo);
    const draft = makeInvoice({
      vendorId: vendor.id,
      clientId: client.id,
      issueDate,
      terms: spec.terms,
      status: spec.status,
      notes: spec.notes || '',
      lineItems: spec.lineItems.map((li) => ({
        description: li.description,
        quantityMilli: parseQuantity(li.quantity),
        rateCents: parseCents(li.rate),
      })),
    });

    // `force` because these are being created at their final status, so
    // there is no prior snapshot the freeze policy could preserve.
    await store.createInvoice(withSnapshots(draft, { vendor, client, force: true }));
  }

  return store;
}
