/**
 * Guest sessions: a private, disposable copy of the app for every visitor.
 *
 * The hosted demo is a public, unauthenticated invoice editor. It has to let
 * strangers create clients and invoices -- an invoicing tool nobody can type
 * into is a screenshot -- while writing nothing to the server. So each visitor
 * gets their own in-memory store, seeded with the ACME cast, held in a Map
 * keyed by a cookie and thrown away on a timer.
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
 *
 * A factory rather than a module singleton, so the thing that decides whether
 * the app runs in demo mode is the entry point that builds the app, not an
 * environment variable read here. What a visitor sees in the chrome -- the
 * banner, the badge, the footer -- is set on `res.locals` per request, in the
 * generic shape the layout renders, so a host wrapping this app can put its
 * own words in the same slots.
 */
import crypto from 'node:crypto';
import { createMemoryBackend } from './storage-memory.js';
import { createJsonStore } from './store.js';
import { readCookie } from './cookies.js';

/**
 * The directory a visitor's store believes it lives in. Never created: the
 * memory backend keys records by path string and touches no filesystem, so
 * this only has to be some absolute path, the same for every visitor.
 */
const DEMO_DIR = '/invoisaurus-demo';

const REPO = 'https://github.com/centricle/invoisaurus';

export function createGuestSessions({
  seed,
  cookie = 'demo_sid',
  /** Same reasoning as the flash cookie: scoped to the mount, not the host. */
  cookiePath = '/',
  /** How long an idle visitor keeps their records. */
  ttlMs = 2 * 60 * 60 * 1000,
  /**
   * How many visitors are held at once.
   *
   * An unbounded Map behind a public URL is a memory leak with an address:
   * every fresh cookie adds an entry and nothing ever removes one. When the
   * cap is hit the least recently seen visitor is dropped, which is the same
   * thing the TTL does, only sooner and under load.
   */
  maxSessions = 500,
} = {}) {
  if (typeof seed !== 'function') throw new TypeError('createGuestSessions needs a seed(store) function.');

  const sessions = new Map(); // sid -> { store, lastSeen }

  function sweep(now) {
    for (const [sid, session] of sessions) {
      if (now - session.lastSeen > ttlMs) sessions.delete(sid);
    }
    // Map iterates in insertion order and `touch` re-inserts, so the oldest
    // entry is the least recently seen one.
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
  }

  function touch(sid, session) {
    sessions.delete(sid);
    sessions.set(sid, { ...session, lastSeen: Date.now() });
  }

  /** Build one visitor's world. */
  async function fresh() {
    const store = createJsonStore({ backend: createMemoryBackend(), dataDir: DEMO_DIR });
    await seed(store);
    return store;
  }

  /**
   * Express middleware. Attaches a session and its store to the request.
   *
   * A cookie that names a session we no longer hold is not an error: containers
   * recycle and sessions expire on a timer, both by design. It reseeds and says
   * so, because work disappearing with no explanation is the one thing that
   * would read as the app being broken rather than the demo being a demo.
   *
   * A request that already carries a store -- a signed-in user on a host that
   * wraps this app -- is left alone. Guests are whoever nobody else claimed.
   */
  async function middleware(req, res, next) {
    if (req.store) return next();

    const now = Date.now();
    sweep(now);

    const sid = readCookie(req, cookie);
    const existing = sid ? sessions.get(sid) : undefined;

    // A cookie naming a session we no longer hold is the reset case, and it is
    // distinguishable from a first visit only by the cookie being there at all.
    const reset = Boolean(sid) && !existing;
    const id = existing ? sid : crypto.randomUUID();
    const session = existing || { store: await fresh(), lastSeen: now };

    touch(id, session);

    res.cookie(cookie, id, {
      path: cookiePath, httpOnly: true, sameSite: 'lax', maxAge: ttlMs,
    });

    req.store = sessions.get(id).store;
    res.locals.demoMode = true;
    res.locals.watermark = true;
    res.locals.badge = 'Demo';
    // Two different messages. A first visit is being told the rules; a reset
    // is being told where their work went, which is the one that would
    // otherwise read as the app losing data.
    res.locals.banner = reset
      ? {
        strong: 'Your demo session expired.',
        text: 'The sample data is back; anything you added is gone.',
        action: { href: '/demo/reset', label: 'Reset demo' },
      }
      : {
        strong: 'This is a demo.',
        text: 'Create and edit anything you like. Nothing is saved, and it all disappears when your session ends.',
        action: { href: '/demo/reset', label: 'Reset demo' },
      };
    // Where the data dir goes locally. In the demo there is no directory to
    // name, so the slot carries the thing a visitor would actually want.
    res.locals.footer = {
      text: 'Records live in memory for this session only.',
      link: { href: REPO, label: 'Run it locally' },
      tail: 'to keep them.',
    };
    return next();
  }

  /** Throw this visitor's records away and start them over. */
  function reset(req, res) {
    const sid = readCookie(req, cookie);
    if (sid) sessions.delete(sid);
    res.clearCookie(cookie, { path: cookiePath });
  }

  return {
    middleware,
    reset,
    /** Test seam: how many visitors are currently held. */
    count: () => sessions.size,
  };
}
