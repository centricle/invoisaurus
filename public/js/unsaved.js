/**
 * Unsaved changes: the save bar, the stale flash, and the leave-page warning.
 *
 * One owner for the question "does this page hold edits that are not on
 * disk", answered the same way everywhere it is asked. A form opts in with
 * `data-track-changes`; there is one such form per page.
 *
 * The answer is a comparison, not a flag set by typing. The form is serialized
 * when the page loads and again on every change, and the two strings either
 * match or they do not. So an edit that is typed and then undone reads as
 * saved again, and a field changed by code rather than by a keystroke -- a due
 * date following its terms, a line added or removed -- counts the same as one
 * typed by hand. This script is deferred, so it takes that first reading after
 * the editor has finished setting fields up on load.
 *
 * One page is unsaved from the moment it loads: a rejected save. The server
 * renders the form again with the input it refused, which matches what loaded
 * and is still not on disk. `[data-form-errors]` is what marks that page.
 *
 * What follows from unsaved:
 *
 *   - The save bar (src/views/partials/save-bar.ejs) shows, pinned to the
 *     bottom of the viewport, and hides again when the form matches. The
 *     theme switch (bottom right) rides up clear of it: this script keeps
 *     --save-bar-offset on the root equal to the bar's measured height, which
 *     app.css reads to push the switch by the same amount. Measured rather
 *     than a constant because the bar's height depends on the root font size
 *     and on wrapping at narrow widths.
 *   - The flash goes, and stays gone. "Invoice saved." was true of the moment
 *     after the save; left on screen above an edit made since, it tells someone
 *     coming back to the page that work is on disk when it is not.
 *   - Leaving the page asks first, unless the page is leaving because a form
 *     was submitted or Discard was confirmed.
 */
(() => {
  const form = document.querySelector('form[data-track-changes]');
  if (!form) return;

  const bar = document.querySelector('[data-save-bar]');
  const rejected = Boolean(document.querySelector('[data-form-errors]'));
  const snapshot = () => new URLSearchParams(new FormData(form)).toString();
  const loaded = snapshot();

  let dirty = false;
  let leaving = false;

  // Read from the bar itself: it takes no space while hidden, and its
  // height while shown depends on the root font size and on wrapping at
  // narrow widths, neither of which is worth duplicating as a constant.
  const placeSwitch = () => document.documentElement.style.setProperty(
    '--save-bar-offset', bar && !bar.hidden ? `${bar.offsetHeight}px` : '0px',
  );

  const update = () => {
    const next = rejected || snapshot() !== loaded;
    if (next === dirty) return;
    dirty = next;
    if (bar) bar.hidden = !dirty;
    placeSwitch();
    if (dirty) document.querySelector('[data-flash]')?.remove();
  };

  form.addEventListener('input', update);
  form.addEventListener('change', update);
  // Adding or removing a line changes the fields without firing an input event.
  new MutationObserver(update).observe(form, { childList: true, subtree: true });
  if (bar) new ResizeObserver(placeSwitch).observe(bar);
  update();

  // Any form's submit is a deliberate way off the page: this one saving, or
  // another (delete, the demo reset) doing what its button says.
  for (const f of document.querySelectorAll('form')) {
    f.addEventListener('submit', () => { leaving = true; });
  }

  bar?.querySelector('[data-discard]')?.addEventListener('click', (e) => {
    if (!confirm('Discard unsaved changes?')) {
      e.preventDefault();
      return;
    }
    // Already confirmed once. Without this the browser asks a second time, in
    // its own words, whether to leave.
    leaving = true;
  });

  window.addEventListener('beforeunload', (e) => {
    if (leaving || !dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
