import type { ReactNode } from 'react';

// Every icon outline of the cards and the simulator, in one place (architecture review: the Lucide path data was
// hand-copied in several files). The outlines marked Lucide are copied from lucide-static 1.55.0 (ISC licence, see
// NOTICE), on their 24 × 24 grid; the rest (the cross, the back chevron, the message dot) are ours. Each part takes
// its class, so the callers keep their own styling and show or hide the live parts. Inline only: the card CSP has no
// images or fetches. Icons sit beside words that already say everything, so the frame hides them from screen readers.

export const ICON_VIEW_BOX = '0 0 24 24';

/** The frame of every icon: the 24 × 24 grid, hidden from screen readers and never focusable. */
export function IconFrame({ className, children, data }: { className: string; children: ReactNode; /** `data-*` attributes, without the prefix. */ data?: Record<string, string> }) {
  const attributes = Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]));
  return (
    <svg className={className} {...attributes} viewBox={ICON_VIEW_BOX} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Lucide "battery": the body and the terminal. */
export function BatteryOutline({ className }: { className: string }) {
  return (
    <>
      <rect x="2" y="6" width="16" height="12" rx="2" className={className} />
      <path d="M22 14v-4" className={className} />
    </>
  );
}

/** Lucide "solar-panel": the sun above the panel. */
export function SolarSun({ className }: { className: string }) {
  return <path d="M11 2h2 M3 10v2 M7 2a4 4 0 0 1-4 4 M8.66 7.66l1.41 1.41" className={className} />;
}

/** Lucide "solar-panel": the panel. */
export function SolarPanelOutline({ className }: { className: string }) {
  return (
    <path
      d="m14.28 14-4.56 8 M21 22l-1.558-4H4.558 M6.245 15.04A2 2 0 0 1 8 14h12a1 1 0 0 1 .864 1.505l-3.11 5.457A2 2 0 0 1 16 22H4a1 1 0 0 1-.863-1.506z"
      className={className}
    />
  );
}

/** Lucide "utility-pole". */
export function UtilityPoleOutline({ className }: { className: string }) {
  return <path d="M12 2v20 M2 5h20 M3 3v2 M7 3v2 M17 3v2 M21 3v2 M19 5l-7 7-7-7" className={className} />;
}

/** Ours: a diagonal cross over the whole grid (something is off). */
export function Cross({ className }: { className: string }) {
  return <path d="M3 3 21 21" className={className} />;
}

/** Lucide "air-vent": the unit. */
export function AirVentUnit({ className }: { className: string }) {
  return <path d="M6 12H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 8h12" className={className} />;
}

/** Lucide "air-vent": its two curls of air. */
export function AirVentAir({ className }: { className: string }) {
  return <path d="M18 17.5a2.5 2.5 0 1 1-4 2.03V12 M6.6 15.572A2 2 0 1 0 10 17v-5" className={className} />;
}

/** Lucide "smartphone". */
export function SmartphoneOutline({ className }: { className: string }) {
  return (
    <>
      <rect x="5" y="2" width="14" height="20" rx="2" className={className} />
      <path d="M12 18h.01" className={className} />
    </>
  );
}

/** Ours: the dot of a new message, top right. */
export function MessageDot({ className }: { className: string }) {
  return <circle cx="18" cy="5" r="4" className={className} />;
}

/** Ours: the chevron of "Back". */
export function BackChevron() {
  return <path d="M15 5 8 12l7 7" />;
}

/** Lucide "languages": a character and an "A", the usual sign for the language choice. */
export function LanguagesOutline() {
  return <path d="m5 8 6 6 M4 14l6-6 2-3 M2 5h12 M7 2h1 M22 22l-5-10-5 10 M14 18h6" />;
}
