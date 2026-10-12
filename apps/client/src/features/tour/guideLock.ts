/**
 * While Thatha is guiding, only what he points at can be used: clicks, taps, keys and map
 * zoom/drag anywhere else are swallowed (capture phase, before React or the 3D canvas see them)
 * and the guide card is nudged instead. Always usable: elements marked `data-guide-allow`
 * (the guide card itself), modal dialogs (confirmations, the away report) and toasts.
 */
import { useEffect } from 'react';

const ALWAYS = ['[data-guide-allow]', '[aria-modal="true"]', '.bh-toasts'];
const POINTER = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'] as const;
const OTHER = ['contextmenu', 'touchstart', 'keydown', 'wheel'] as const;

export const NUDGE_EVENT = 'bh-guide-nudge';

/** `allow` = selectors that stay usable; null = no lock. */
export function useGuideLock(allow: string[] | null) {
  const selector = allow ? [...ALWAYS, ...allow].join(',') : null;

  useEffect(() => {
    if (!selector) return;
    let last = 0;
    const block = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(selector)) return;
      // Scrolling a list is not "doing" anything; only the 3D camera wheel is locked.
      if (e.type === 'wheel' && !(target instanceof HTMLCanvasElement)) return;
      if (e instanceof KeyboardEvent && (e.key === 'Tab' || e.key === 'Shift')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'pointerdown' || e.type === 'keydown') {
        const now = performance.now();
        if (now - last > 400) window.dispatchEvent(new Event(NUDGE_EVENT));
        last = now;
      }
    };
    const opts = { capture: true, passive: false };
    for (const t of [...POINTER, ...OTHER]) window.addEventListener(t, block, opts);
    return () => {
      for (const t of [...POINTER, ...OTHER]) window.removeEventListener(t, block, opts);
    };
  }, [selector]);
}
