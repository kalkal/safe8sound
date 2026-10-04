// Demo mode for the video (scene recording): each press leaves a short circle where the pointer went down,
// so a viewer sees what was touched. The host turns it on (`?demo=1`) and tells each card through its own
// hostContext key; a real Alexa+ host never sends it, so the cards never draw a mark there.
//
// No stylesheet: the mark is styled property by property through element.style and moved with the Web Animations
// API, reading only design tokens. A card's inline <style> stays byte for byte the same in and out of demo mode, so
// the hashes of the site's CSP (style-src without 'unsafe-inline') never change. Setting style properties from a
// script is not inline CSS in the CSP sense (only style attributes and <style> elements are); the site E2E
// (e2e/site/csp.spec.ts) checks it with demo mode on.

/** The hostContext key the simulator sets in demo mode (MCP Apps allows extra keys in hostContext). */
export const DEMO_CONTEXT_KEY = 'coldReserveDemo';
/** How long a mark stays on screen. */
export const TAP_MARK_MS = 650;

export function isDemoContext(context: Readonly<Record<string, unknown>> | undefined): boolean {
  return context?.[DEMO_CONTEXT_KEY] === true;
}

const MARK_STYLE: ReadonlyArray<[string, string]> = [
  ['position', 'fixed'],
  ['z-index', '2147483647'],
  ['inline-size', 'var(--target-min)'],
  ['block-size', 'var(--target-min)'],
  ['margin', 'calc(var(--target-min) / -2) 0 0 calc(var(--target-min) / -2)'],
  ['border', 'calc(var(--border-thin) * 3) solid var(--accent)'],
  ['border-radius', 'var(--radius-pill)'],
  ['background', 'color-mix(in oklab, var(--accent) 30%, transparent)'],
  ['pointer-events', 'none'],
  ['box-sizing', 'border-box'],
];

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Draws a tap mark at every press in `doc`; returns the function that stops it and removes the marks left. */
export function installTapMarks(doc: Document): () => void {
  const marks = new Set<HTMLElement>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const onDown = (event: Event) => {
    if (!(event instanceof MouseEvent)) return;
    const mark = doc.createElement('span');
    mark.className = 'demo-tap';
    mark.setAttribute('aria-hidden', 'true');
    for (const [name, value] of MARK_STYLE) mark.style.setProperty(name, value);
    mark.style.left = `${String(event.clientX)}px`;
    mark.style.top = `${String(event.clientY)}px`;
    doc.body.append(mark);
    marks.add(mark);
    // With reduced motion the circle stays still where it was pressed, then goes.
    if (!reducedMotion() && typeof mark.animate === 'function') {
      mark.animate(
        [
          { opacity: 1, transform: 'scale(0.6)' },
          { opacity: 0, transform: 'scale(1.4)' },
        ],
        { duration: TAP_MARK_MS, easing: 'ease-out', fill: 'forwards' },
      );
    }
    const timer = setTimeout(() => {
      mark.remove();
      marks.delete(mark);
      timers.delete(timer);
    }, TAP_MARK_MS);
    timers.add(timer);
  };
  // Capture, passive: the mark is drawn before the page reacts, and never stops the press.
  doc.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('pointerdown', onDown, { capture: true });
    timers.forEach((timer) => {
      clearTimeout(timer);
    });
    marks.forEach((mark) => {
      mark.remove();
    });
    marks.clear();
    timers.clear();
  };
}
