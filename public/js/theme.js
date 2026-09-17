/**
 * The theme control: an icon-only segmented radiogroup for dark, system, and
 * light (see src/views/partials/theme-control.ejs).
 *
 * The choice is written to a cookie rather than localStorage so the server
 * can render the choice before the page is sent: the layout sets `data-theme`
 * on `<html>` from it (see src/theme.js), and a page that learned the theme
 * from script after loading would paint in the other one first. Scoped to
 * the path the app is mounted under, which the control passes in
 * `data-cookie-path`, for the same reason the flash cookie is: an app served
 * under a prefix must not set a cookie for the whole site it lives inside.
 *
 * The server renders `aria-checked` and the roving `tabindex` from
 * `res.locals.theme` on every page load, so this script only reacts to a
 * click or an arrow key.
 */
(() => {
  const root = document.documentElement;

  document.querySelectorAll('[data-theme-control]').forEach((group) => {
    const buttons = [...group.querySelectorAll('[data-theme-value]')];
    const cookiePath = group.dataset.cookiePath || '/';

    const select = (button) => {
      const value = button.dataset.themeValue;

      if (value) {
        root.dataset.theme = value;
        const secure = location.protocol === 'https:' ? '; secure' : '';
        document.cookie = `theme=${value}; path=${cookiePath}; max-age=31536000; samesite=lax${secure}`;
      } else {
        delete root.dataset.theme;
        // No value at all, rather than an empty one: an empty cookie value
        // is a cookie, and would round-trip through src/theme.js the same as
        // a real choice if this ever forgot to delete it here too.
        document.cookie = `theme=; path=${cookiePath}; max-age=0; samesite=lax`;
      }

      for (const b of buttons) {
        const checked = b === button;
        b.setAttribute('aria-checked', String(checked));
        b.tabIndex = checked ? 0 : -1;
      }
    };

    buttons.forEach((button, index) => {
      button.addEventListener('click', () => select(button));

      // Roving tabindex, per the APG radiogroup pattern: arrow keys move
      // focus between segments and, same as a native radio input, select
      // the one they land on immediately rather than waiting for Enter.
      button.addEventListener('keydown', (e) => {
        let next;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % buttons.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
        else return;

        e.preventDefault();
        buttons[next].focus();
        select(buttons[next]);
      });
    });
  });
})();
