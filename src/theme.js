/**
 * Which theme the reader chose, if they chose one.
 *
 * The interface follows the operating system's light or dark setting until the
 * reader clicks the toggle in the header. That choice is kept in a cookie, not
 * in localStorage, because the server has to know it before the page is sent:
 * the layout renders it as `data-theme` on `<html>`, and a page that learned
 * the theme from script after loading would paint in the other one first.
 *
 * The cookie is written by public/js/theme.js and only read here. Its value
 * lands in an HTML attribute, so anything other than the two known words is
 * treated as no choice at all, and the OS setting applies.
 */
import { readCookie } from './cookies.js';

export const THEME_COOKIE = 'theme';
export const THEMES = ['light', 'dark'];

export function readTheme(req) {
  let value = '';
  // readCookie percent-decodes, and decodeURIComponent throws on a malformed
  // sequence such as `%E0%A4%A`. This runs on every page, so a mangled cookie
  // would otherwise turn every page into a 500 until it expired.
  try {
    value = readCookie(req, THEME_COOKIE);
  } catch {
    return '';
  }
  return THEMES.includes(value) ? value : '';
}
