/**
 * Demo mode: a private, disposable copy of the app for every visitor.
 *
 * The hosted demo is a public, unauthenticated invoice editor. It has to let
 * strangers create clients and invoices -- an invoicing tool nobody can type
 * into is a screenshot -- while writing nothing to the server. So each visitor
 * gets their own in-memory storage backend, seeded with the ACME cast, held in
 * a Map keyed by a cookie and thrown away on a timer.
 *
 * **Nothing is threaded through the routes.** The backend is carried in an
 * `AsyncLocalStorage`, which the storage layer reads, so every route, every
 * validator and every store function is the same code the local tool runs.
 * Passing a session down through seven handlers would mean the demo and the
 * product no longer share a call path, which is the point at which a demo
 * starts being able to disagree with the thing it is demonstrating.
 *
 * The state is deliberately not durable. A Lambda container recycles and the
 * session is gone; the banner says as much, and `reset` does it on purpose.
 * Persisting it would mean a real write surface that strangers can fill, which
 * is the thing this whole design exists to avoid.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { DEMO_MODE } from './config.js';
import { fsBackend, useBackendResolver } from './storage.js';
import { createMemoryBackend } from './storage-memory.js';
import {
  ensureDataDir, createVendor, createClient, allocateInvoiceNumber, saveInvoice,
} from './store.js';
import { makeInvoice, withSnapshots, today, addDays } from './schema.js';
import { parseQuantity, parseCents } from './money.js';
import { VENDOR, CLIENT, DEMO_CLIENTS, DEMO_INVOICES } from './fixtures/acme.js';

export const COOKIE = 'demo_sid';

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

const store = new Map(); // sid -> { backend, lastSeen }
const als = new AsyncLocalStorage();

export const isDemoMode = () => DEMO_MODE;

/** Install the resolver once, at startup. Off in a normal install. */
export function installDemoBackend() {
  if (!DEMO_MODE) return;
  useBackendResolver(() => als.getStore()?.backend ?? fsBackend);
}

function sweep(now) {
  for (const [sid, session] of store) {
    if (now - session.lastSeen > TTL_MS) store.delete(sid);
  }
  // Map iterates in insertion order and `touch` re-inserts, so the oldest
  // entry is the least recently seen one.
  while (store.size > MAX_SESSIONS) store.delete(store.keys().next().value);
}

function touch(sid, session) {
  store.delete(sid);
  store.set(sid, { ...session, lastSeen: Date.now() });
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
function seed() {
  const backend = createMemoryBackend();

  als.run({ backend }, () => {
    ensureDataDir();
    const vendor = createVendor(VENDOR);
    const clients = new Map();
    for (const record of [CLIENT, ...DEMO_CLIENTS]) {
      const created = createClient(record);
      clients.set(created.id, created);
    }

    for (const spec of DEMO_INVOICES) {
      const client = clients.get(spec.client);
      if (!client) continue;

      const issueDate = addDays(today(), -spec.issuedDaysAgo);
      const { number, id } = allocateInvoiceNumber(vendor.id);
      const draft = makeInvoice({
        id,
        number,
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
      saveInvoice(withSnapshots(draft, { vendor, client, force: true }), { create: true });
    }
  });

  return backend;
}

/**
 * Express middleware. Attaches a session and runs the request inside it.
 *
 * A cookie that names a session we no longer hold is not an error: containers
 * recycle and sessions expire on a timer, both by design. It reseeds and says
 * so, because work disappearing with no explanation is the one thing that
 * would read as the app being broken rather than the demo being a demo.
 */
export function demoSession(req, res, next) {
  if (!DEMO_MODE) return next();

  const now = Date.now();
  sweep(now);

  const sid = readCookie(req, COOKIE);
  const existing = sid ? store.get(sid) : undefined;

  // A cookie naming a session we no longer hold is the reset case, and it is
  // distinguishable from a first visit only by the cookie being there at all.
  const reset = Boolean(sid) && !existing;
  const id = existing ? sid : crypto.randomUUID();
  const session = existing || { backend: seed(), lastSeen: now };

  touch(id, session);

  res.cookie(COOKIE, id, {
    path: '/', httpOnly: true, sameSite: 'lax', maxAge: TTL_MS,
  });
  res.locals.demoMode = true;
  res.locals.demoReset = reset;

  return als.run({ backend: store.get(id).backend }, next);
}

/** Throw this visitor's records away and start them over. */
export function resetSession(req, res) {
  const sid = readCookie(req, COOKIE);
  if (sid) store.delete(sid);
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const entry = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

/** Test seam: how many visitors are currently held. */
export const sessionCount = () => store.size;
