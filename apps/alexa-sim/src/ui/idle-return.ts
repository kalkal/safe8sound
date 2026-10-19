import { useEffect, useRef } from 'react';

// Back to the idle screen (#432 S6, owner 18 Oct): a real Echo Show cleans its screen by itself after a while; ours
// does it `delayMs` after the last touch, key or scroll (config.idleReturnMs: one minute, our choice; Amazon publishes
// no value for the Echo Show). The caller says when the clock runs (an answer or the home on screen, the voice done, no
// plan waiting for its choice). It also waits while something else waits for the person: a modal dialog (a card at
// full screen, a sheet) or the focus inside a card's frame (touches inside a frame never reach this page).

const ACTIVITY = ['pointerdown', 'keydown', 'wheel'] as const;

function somethingWaits(doc: Document): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null || doc.activeElement?.tagName === 'IFRAME';
}

export function useIdleReturn(o: { active: boolean; delayMs: number; onReturn: () => void }): void {
  const { active, delayMs } = o;
  // Read when the time is up: the caller may hand a new function at each render.
  const onReturnRef = useRef(o.onReturn);
  onReturnRef.current = o.onReturn;
  useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (somethingWaits(document)) restart();
        else onReturnRef.current();
      }, delayMs);
    };
    restart();
    for (const type of ACTIVITY) window.addEventListener(type, restart, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const type of ACTIVITY) window.removeEventListener(type, restart, { capture: true });
    };
  }, [active, delayMs]);
}
