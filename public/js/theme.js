/**
 * The light/dark switch at the bottom right of the screen.
 *
 * Until the reader clicks it, the page follows the operating system: the root
 * carries no `data-theme`, and `color-scheme: light dark` in public/css/app.css
 * lets the OS decide which half of each `light-dark()` color applies. A click
 * pins the opposite of whatever is showing by setting the attribute, which
 * repaints at once with no reload, so an invoice with unsaved edits keeps them.
 *
 * The choice is written to a cookie rather than localStorage so the server can
 * render the attribute on the next page (see src/theme.js). Scoped to the path
 * the app is mounted under, which the layout passes in `data-cookie-path`, for
 * the same reason the flash cookie is: an app served under a prefix must not
 * set a cookie for the whole site it lives inside.
 *
 * There is no way back to "follow the OS" short of clearing the cookie. Two
 * states was the decision; a third needs a menu rather than one button.
 *
 * The server cannot know the OS setting, so a visitor with no cookie renders
 * with `aria-checked` guessed from the server's own default (dark) rather than
 * the reader's actual OS preference. `sync()` corrects that on load, and
 * `data-theme-ready` is only added in the following animation frame, so
 * app.css's switch transitions -- track color, knob position, icon opacity --
 * stay off for that first, corrective paint and only apply to a click made
 * after. Without the delay, a light-OS reader with no cookie would see the
 * knob visibly slide into place on every page load.
 */
(() => {
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;

  const root = document.documentElement;
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  const showing = () => root.dataset.theme || (systemLight.matches ? 'light' : 'dark');
  const opposite = () => (showing() === 'light' ? 'dark' : 'light');

  // A switch keeps one label naming what "on" means -- aria-checked carries
  // the state, so aria-label stays "Light theme" rather than being rewritten
  // to describe the next click.
  const sync = () => {
    const light = showing() === 'light';
    button.setAttribute('aria-checked', String(light));
    const text = `Switch to ${light ? 'dark' : 'light'} theme`;
    button.title = text;
  };

  button.addEventListener('click', () => {
    const next = opposite();
    root.dataset.theme = next;
    const path = button.dataset.cookiePath || '/';
    document.cookie = `theme=${next}; path=${path}; max-age=31536000; samesite=lax`;
    sync();
  });

  // With no choice made, the OS can switch while the page is open.
  systemLight.addEventListener('change', sync);
  sync();
  requestAnimationFrame(() => button.setAttribute('data-theme-ready', ''));
})();
