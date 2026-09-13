/**
 * Demo mode: a private, disposable copy of the app for every visitor.
 *
 * The hosted demo is a public, unauthenticated invoice editor. It has to let
 * strangers create clients and invoices -- an invoicing tool nobody can type
 * into is a screenshot -- while writing nothing to the server. So each visitor
 * gets their own in-memory storage backend, seeded with the ACME cast, held in
 * a Map keyed by a cookie and thrown away on a timer.
 *
 * **The routes do not know.** A visitor's store is attached to the request as
 * `req.store`, which is where every handler reads its store from in every
 * mode, so every route, every validator and every store rule is the same code
 * the local tool runs. A demo-specific branch inside the handlers would mean
 * the demo and the product no longer share a call path, which is the point at
 * which a demo starts being able to disagree with the thing it is
 * demonstrating.
 *
 * The state is deliberately not durable. A Lambda container recycles and the
 * session is gone; the banner says as much, and `reset` does it on purpose.
 * Persisting it would mean a real write surface that strangers can fill, which
 * is the thing this whole design exists to avoid.
 */
import crypto from 'node:crypto';
import { DEMO_MODE, BASE_PATH } from './config.js';
import { createMemoryBackend } from './storage-memory.js';
import { createJsonStore } from './store.js';
import { makeInvoice, withSnapshots, today, addDays } from './schema.js';
import { parseQuantity, parseCents } from './money.js';
import { VENDOR, CLIENT, DEMO_CLIENTS, DEMO_INVOICES } from './fixtures/acme.js';

export const COOKIE = 'demo_sid';

/** Same reasoning as the flash cookie: scoped to the mount, not the host. */
const COOKIE_PATH = BASE_PATH || '/';

/** How long an idle visitor keeps their records. */
const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * How many visitors are held at once.
 *
 * An unbounded Map behind a public URL is a memory leak with an address: every
 * fresh cookie adds an entry and nothing ever removes one. When the cap is hit
 * the least recently seen visitor is dropped, which is the same thing the TTL
 * does, only sooner and under load.
 */
const MAX_SESSIONS = 500;

const sessions = new Map(); // sid -> { store, lastSeen }

/**
 * The directory a visitor's store believes it lives in. Never created: the
 * memory backend keys records by path string and touches no filesystem, so
 * this only has to be some absolute path, the same for every visitor.
 */
const DEMO_DIR = '/invoisaurus-demo';

export const isDemoMode = () => DEMO_MODE;

function sweep(now) {
  for (const [sid, session] of sessions) {
    if (now - session.lastSeen > TTL_MS) sessions.delete(sid);
  }
  // Map iterates in insertion order and `touch` re-inserts, so the oldest
  // entry is the least recently seen one.
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function touch(sid, session) {
  sessions.delete(sid);
  sessions.set(sid, { ...session, lastSeen: Date.now() });
}

/**
 * Build one visitor's world.
 *
 * Runs the real store functions inside the session context rather than
 * hand-assembling JSON, so the seeded records are created by the same code
 * paths a visitor's own records will be -- ids derived the same way, numbers
 * allocated from the same counter, snapshots frozen by the same policy. A
 * hand-built fixture is how a demo ends up containing records the app itself
 * could not have produced.
 */
async function seed() {
  const store = createJsonStore({ backend: createMemoryBackend(), dataDir: DEMO_DIR });

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

/**
 * Express middleware. Attaches a session and runs the request inside it.
 *
 * A cookie that names a session we no longer hold is not an error: containers
 * recycle and sessions expire on a timer, both by design. It reseeds and says
 * so, because work disappearing with no explanation is the one thing that
 * would read as the app being broken rather than the demo being a demo.
 */
export async function demoSession(req, res, next) {
  if (!DEMO_MODE) return next();

  const now = Date.now();
  sweep(now);

  const sid = readCookie(req, COOKIE);
  const existing = sid ? sessions.get(sid) : undefined;

  // A cookie naming a session we no longer hold is the reset case, and it is
  // distinguishable from a first visit only by the cookie being there at all.
  const reset = Boolean(sid) && !existing;
  const id = existing ? sid : crypto.randomUUID();
  const session = existing || { store: await seed(), lastSeen: now };

  touch(id, session);

  res.cookie(COOKIE, id, {
    path: COOKIE_PATH, httpOnly: true, sameSite: 'lax', maxAge: TTL_MS,
  });
  res.locals.demoMode = true;
  res.locals.demoReset = reset;

  req.store = sessions.get(id).store;
  return next();
}

/** Throw this visitor's records away and start them over. */
export function resetSession(req, res) {
  const sid = readCookie(req, COOKIE);
  if (sid) sessions.delete(sid);
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const entry = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

/** Test seam: how many visitors are currently held. */
export const sessionCount = () => sessions.size;
