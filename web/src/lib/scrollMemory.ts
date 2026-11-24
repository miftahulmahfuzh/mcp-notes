/** How long a restore waits for the page to grow tall enough before settling for the lowest point it has. */
export const RESTORE_WAIT_MS = 4000;

/** What the user does to scroll by hand: any of these ends a restore, so the page is never pulled from under them. */
const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * Scrolls the window back to `top`. A page that has just been put back is often not tall enough
 * yet (its lists render over the next frames, a section's data arrives later), and a scroll past
 * the end is clamped, so this waits, frame by frame, until `top` can be reached and scrolls then.
 * After RESTORE_WAIT_MS it scrolls as far down as the page goes. `done` is called once, when the
 * restore ends for any reason but the returned cancel.
 */
export function restoreScroll(top: number, done: () => void = () => {}): () => void {
  const started = performance.now();
  let frame = 0;
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    window.cancelAnimationFrame(frame);
    for (const type of USER_INPUT) window.removeEventListener(type, finish, true);
  };
  const end = () => {
    if (over) return;
    finish();
    done();
  };
  const step = () => {
    if (over) return;
    const reach = document.documentElement.scrollHeight - window.innerHeight;
    if (reach >= top) {
      window.scrollTo(0, top);
      end();
    } else if (performance.now() - started >= RESTORE_WAIT_MS) {
      window.scrollTo(0, Math.max(0, reach));
      end();
    } else frame = window.requestAnimationFrame(step);
  };
  for (const type of USER_INPUT) window.addEventListener(type, end, { capture: true, passive: true });
  step();
  return finish;
}
