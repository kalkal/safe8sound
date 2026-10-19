import { useEffect, useRef, type RefObject } from 'react';
import { makeRestInert } from '../host/inert.js';

/**
 * A modal sheet or drawer (owner, 18 Oct): while it is open the rest of the page is inert (the scrim dims it), the focus
 * starts inside it, Escape closes it wherever the focus is, and once closed the focus goes back to the button that
 * opened it. The settings drawer and the judges' demo controls share it.
 */
export function useModal(o: { open: boolean; close: () => void; dialog: RefObject<HTMLElement | null>; layer: RefObject<HTMLElement | null>; opener: RefObject<HTMLElement | null> }): void {
  const { open, close, dialog, layer, opener } = o;
  const closeRef = useRef(close);
  closeRef.current = close;
  // Back to the opener once the page is no longer inert (the inert effect's cleanup runs first).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open && wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open, opener]);
  useEffect(() => {
    if (!open || dialog.current === null) return undefined;
    dialog.current.focus();
    const restoreRest = makeRestInert(layer.current ?? dialog.current);
    // Escape closes it wherever the focus is, even after the tapped button went away (Restart → its confirmation).
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
      restoreRest();
    };
  }, [open, dialog, layer]);
}
