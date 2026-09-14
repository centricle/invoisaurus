/**
 * Read one cookie off a request, without a parser dependency.
 *
 * Three things in this app read a cookie -- the flash, a demo visitor's
 * session, and whatever a host wraps around it -- and none of them needs
 * more than the value of one named cookie. The first occurrence wins, which
 * is what a browser sends first for the most specific path.
 */
export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const entry = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
