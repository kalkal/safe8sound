import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fitScale } from '../fit.js';

/** Below this height the giant numbers drop to their smallest size (--font-size-hero-min). */
const TIGHT_BELOW_PX = 420;

/**
 * The card inside the height its host gives it (MCP Apps containerDimensions.maxHeight): a page that does not fit is
 * scaled down from the top centre. The scale never changes the layout width, so the measured height stays the same
 * whatever the scale (no back-and-forth). Without a height (full screen, a plain page) nothing changes.
 */
export function Fit({ maxHeight, children }: { maxHeight: number | undefined; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState(0);
  useEffect(() => {
    const el = inner.current;
    if (!el) return undefined;
    const measure = () => {
      setNatural(el.offsetHeight);
    };
    measure();
    // A document without layout (a unit test) has nothing to observe.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  const scale = fitScale(natural, maxHeight);
  // A short frame (a small Echo, a card under tabs): the giant numbers at their smallest size before any scaling.
  const tight = maxHeight !== undefined && maxHeight < TIGHT_BELOW_PX;
  useEffect(() => {
    document.documentElement.toggleAttribute('data-fit-tight', tight);
  }, [tight]);
  return (
    <div className="fit" data-scale={scale} style={scale < 1 ? { blockSize: `${String(Math.floor(natural * scale))}px` } : undefined}>
      <div ref={inner} className="fit-inner" style={scale < 1 ? { transform: `scale(${String(scale)})` } : undefined}>
        {children}
      </div>
    </div>
  );
}
