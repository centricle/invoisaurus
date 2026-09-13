/**
 * Place a hint popover under the button that opened it.
 *
 * A `[popover]` element renders in the top layer, where it is positioned
 * against the viewport and no ancestor can act as its containing block. CSS
 * anchor positioning is the declarative fix and is not in every browser yet,
 * so this reads the invoker's rectangle on open and writes it as fixed
 * coordinates. The popover is closed on scroll rather than tracked, because a
 * card that follows the page is more code than a card you reopen.
 */
(() => {
  const GAP = 6;
  const MARGIN = 16;

  for (const pop of document.querySelectorAll('.hint-popover')) {
    const button = document.querySelector(`[popovertarget="${pop.id}"]`);
    if (!button) continue;

    pop.addEventListener('toggle', (e) => {
      if (e.newState !== 'open') return;
      const r = button.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - MARGIN);
      const below = r.bottom + GAP;
      const fitsBelow = below + pop.offsetHeight <= window.innerHeight - MARGIN;
      pop.style.top = `${fitsBelow ? below : r.top - GAP - pop.offsetHeight}px`;
      pop.style.left = `${Math.max(MARGIN, left)}px`;
      window.addEventListener('scroll', () => {
        if (pop.matches(':popover-open')) pop.hidePopover();
      }, { once: true, passive: true });
    });
  }
})();
