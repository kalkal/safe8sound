import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fitCramped, fitFrame, fitOverhang, fitScale } from '../fit.js';

/**
 * The card inside the height its host gives it (MCP Apps containerDimensions.maxHeight): a page that does not fit is
 * scaled down from the top centre. The scale never changes the layout width, so the measured height stays the same
 * whatever the scale (no back-and-forth). Without a height (full screen, a plain page) nothing changes.
 * Never below the readable scale (owner, 12 Oct): a page still too tall there is cut at the height, its end fading, and
 * `onCramped` tells the card, which then offers full screen.
 */
export function Fit({ maxHeight, onCramped, children }: { maxHeight: number | undefined; onCramped?: (cramped: boolean) => void; children: ReactNode }) {
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
  const cramped = fitCramped(natural, maxHeight);
  const { tight, compact } = fitFrame(maxHeight);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-fit-tight', tight);
    document.documentElement.toggleAttribute('data-fit-compact', compact);
  }, [tight, compact]);
  const onCrampedRef = useRef(onCramped);
  onCrampedRef.current = onCramped;
  useEffect(() => {
    onCrampedRef.current?.(cramped);
  }, [cramped]);
  const height = cramped && maxHeight !== undefined ? maxHeight : Math.floor(natural * scale);
  return (
    <div className="fit" data-scale={scale} data-cramped={cramped} style={scale < 1 ? fitStyle(height, scale, cramped) : undefined}>
      <div ref={inner} className="fit-inner" style={scale < 1 ? { transform: `scale(${String(scale)})` } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** The frame's height and, on a cut page, the overhang its button row is lowered by to stay at the cut (#371). */
function fitStyle(height: number, scale: number, cramped: boolean): CSSProperties {
  const style: Record<string, string> = { blockSize: `${String(height)}px` };
  if (cramped) style['--fit-overhang'] = `${String(fitOverhang(height, scale))}px`;
  return style;
}
