/**
 * The one cast, shared by the seed script and the hosted demo.
 *
 * Fleet convention (`rig/runbooks/FAKE_DATA.md`): ACME Corporation sells to
 * Wile E. Coyote, the Road Runner is the one that got away, and Bugs Bunny is
 * the record that works out. Hostnames are `.example`, which is RFC 2606
 * reserved and can never be registered, so a demo address cannot become
 * someone's real inbox. Product codes and rates come from
 * `rig/scripts/fake-data.mjs catalog` rather than being invented here.
 *
 * The reason this is a module and not two copies: `scripts/seed.mjs` writes to
 * a real data directory and the demo builds a throwaway one, but a reader who
 * runs both should see the same company. Divergence between them reads as a
 * bug in the app rather than as two fixtures drifting.
 */

export const VENDOR = {
  name: 'ACME Corporation',
  email: 'billing@acme-corp.example',
  address: { street: '1 Anvil Plaza', city: 'Sedona', state: 'AZ', zip: '86336' },
  numberPrefix: 'ACM-',
  numberPad: 4,
  nextNumber: 1,
};

export const CLIENT = {
  name: 'Wile E. Coyote',
  displayName: '',
  type: 'individual',
  contactName: '',
  address: { street: '22 Mesa Verde Rd', city: 'Tucumcari', state: 'NM', zip: '88401' },
};

export const LINE_ITEMS = [
  { description: 'Rocket skates (model XLR-8): fitting and trajectory calibration', quantity: '3.5', rate: '150.00' },
  { description: 'Anvil, expedited cliffside delivery', quantity: '2', rate: '85.00' },
];

export const NOTES = 'Payment due within 30 days. ACME accepts no liability for outcomes '
  + 'involving cliffs, tunnels painted on rock faces, or product used contrary to the manual.';

export const VENDOR_ID = 'acme-corporation'; // slugify('ACME Corporation')
export const CLIENT_ID = 'wile-e-coyote';    // slugify('Wile E. Coyote')

// --- Demo only -------------------------------------------------------------

/**
 * Two more customers, so the hosted demo has something to be a list of.
 *
 * `npm run seed` deliberately does not create these. It populates a real data
 * directory that someone is about to put their own records in, and one
 * obviously-fake client is a sample; three is a mess to clean up.
 */
export const DEMO_CLIENTS = [
  {
    name: 'Acceleratti Incredibilus, LLC',
    displayName: 'Road Runner',
    type: 'business',
    contactName: '',
    address: { street: '1 Desert Route 66', city: 'Kingman', state: 'AZ', zip: '86401' },
  },
  {
    name: 'Rabbitus Idioticus, LLC',
    displayName: 'Bugs Bunny',
    type: 'business',
    contactName: '',
    address: { street: '7 Carrot Burrow Ln', city: 'Albuquerque', state: 'NM', zip: '87101' },
  },
];

/**
 * The invoices the demo opens on, chosen so every status badge is on screen at
 * once: a draft, a sent invoice that is not due yet, a sent invoice that is
 * overdue, a paid one, and a void one.
 *
 * `issuedDaysAgo` rather than a fixed date, because an invoice hardcoded as
 * overdue stops being overdue the moment the demo outlives the date, and a
 * demo whose headline feature quietly switches off is worse than one without
 * it. The Road Runner is the unpaid one on canon grounds: never buys anything,
 * never replies.
 *
 * The void entry is not filler. It is the only way to show that a number is
 * retired rather than recycled, which is the invoice-numbering rule this app
 * is most opinionated about.
 */
export const DEMO_INVOICES = [
  {
    client: 'wile-e-coyote', status: 'draft', terms: 'net30', issuedDaysAgo: 0, notes: NOTES,
    lineItems: LINE_ITEMS,
  },
  {
    client: 'road-runner', status: 'sent', terms: 'net30', issuedDaysAgo: 62,
    lineItems: [
      { description: 'Instant road, unrolls to any terminus (RD-INS)', quantity: '3', rate: '97.00' },
      { description: 'High-speed tonic, one dose, effects irreversible (TON-HS)', quantity: '2', rate: '22.00' },
    ],
  },
  {
    client: 'wile-e-coyote', status: 'sent', terms: 'net30', issuedDaysAgo: 9,
    lineItems: [
      { description: 'Giant electromagnet, 99-mile attraction radius (MAG-99)', quantity: '1', rate: '420.00' },
      { description: 'Iron bird seed, magnetic grade (SED-IR)', quantity: '40', rate: '8.25' },
    ],
  },
  {
    client: 'bugs-bunny', status: 'paid', terms: 'net15', issuedDaysAgo: 45,
    lineItems: [
      { description: 'Giant kite kit, assembly required, wind not included (KIT-GK)', quantity: '2', rate: '56.00' },
      { description: 'Super outfit, cape and tights, flight sold separately (SUP-OF)', quantity: '1', rate: '29.00' },
    ],
  },
  {
    client: 'wile-e-coyote', status: 'void', terms: 'net30', issuedDaysAgo: 30,
    notes: 'Voided: tunnel paint shipped to the wrong rock face. Reissued separately.',
    lineItems: [
      { description: 'Tunnel paint, photorealistic, works on solid rock (PNT-TN)', quantity: '5', rate: '64.50' },
    ],
  },
];
