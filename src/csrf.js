/**
 * Cross-site request forgery, refused without a dependency.
 *
 * Every state change in this app is a form post, and a form post is something
 * any page on the internet can make a browser send, with that browser's
 * cookies attached. Locally that was moot: the server binds loopback and
 * there are no cookies worth having. Hosted -- as a demo, or by anyone who
 * forks the repository and points Netlify at it -- the same handlers are a
 * public write surface, so a request has to prove it came from a page this
 * app served. Two proofs are accepted, checked in this order:
 *
 * 1. **What the browser says.** Modern browsers label every request with
 *    `Sec-Fetch-Site` (same-origin, same-site, cross-site, none) and, on a
 *    POST, `Origin`. Neither can be set by a page; both are set by the
 *    browser from where the request actually came from. A `same-origin`
 *    request is accepted as it stands. A `cross-site` one is refused, whatever
 *    else it carries, because the browser has already answered the question.
 *    An `Origin` alone is accepted when it is this app's own origin or one
 *    the operator named in `allowOrigins` -- which is how an app proxied
 *    under another site's path still works, since the origin a browser sees
 *    is the proxy's, not the function's.
 *
 * 2. **A token the page carried.** For a client that sends neither header,
 *    the classic double submit: a random token in an httpOnly cookie, echoed
 *    back in a hidden field the page rendered. Another site cannot read the
 *    cookie and so cannot forge the field. `SameSite=Lax` on the cookie is a
 *    third, overlapping defense, and the reason a top-level navigation POST
 *    from elsewhere arrives with no cookie at all.
 *
 * The cookie is minted on the first request without one, whatever the method,
 * so a page that was rendered before the cookie existed still gets a working
 * token on its next load. A stale token -- a tab left open across a cookie
 * change -- is a 403 with instructions, not a silent save of nothing.
 */
import crypto from 'node:crypto';
import { readCookie } from './cookies.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN = /^[a-f0-9]{64}$/;

export function createCsrf({ cookie = 'csrf', cookiePath = '/', allowOrigins = [] } = {}) {
  const allowed = new Set(allowOrigins.map((o) => String(o).replace(/\/+$/, '')));
  const selfOrigin = (req) => `${req.protocol}://${req.get('host')}`;

  /** Why a request was refused, or 'ok'. Named so the 403 page can say. */
  function verdict(req, token, minted) {
    const site = req.get('sec-fetch-site');
    if (site) return site === 'same-origin' || site === 'none' ? 'ok' : 'cross-site';

    const origin = req.get('origin');
    if (origin) return allowed.has(origin) || origin === selfOrigin(req) ? 'ok' : 'origin';

    const sent = String(req.body?._csrf ?? '');
    if (minted || !TOKEN.test(sent)) return 'token';
    return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(token)) ? 'ok' : 'token';
  }

  function middleware(req, res, next) {
    let token = readCookie(req, cookie);
    let minted = false;
    if (!TOKEN.test(token)) {
      token = crypto.randomBytes(32).toString('hex');
      res.cookie(cookie, token, { path: cookiePath, httpOnly: true, sameSite: 'lax' });
      minted = true;
    }
    res.locals.csrfToken = token;
    // Rendered into every form that changes anything. The value is hex, so it
    // needs no escaping, and the field name is fixed so a form cannot get it
    // subtly wrong.
    res.locals.csrfField = () => `<input type="hidden" name="_csrf" value="${token}">`;

    if (SAFE.has(req.method)) return next();

    const why = verdict(req, token, minted);
    if (why === 'ok') return next();
    return res.status(403).render('403', { why });
  }

  return { middleware };
}
