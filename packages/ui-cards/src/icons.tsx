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

/** Lucide "menu": the Echo screen's menu, top left (#432 S6). */
export function MenuOutline() {
  return <path d="M4 5h16 M4 12h16 M4 19h16" />;
}

/** Lucide "bell": the Echo screen's notifications, top left, with `MessageDot` when one is new (#432 S6). */
export function BellOutline() {
  return <path d="M10.268 21a2 2 0 0 0 3.464 0 M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />;
}

/** Lucide "mic": the microphone, the one control on the Echo screen. */
export function MicOutline() {
  return (
    <>
      <path d="M12 19v3 M19 10v2a7 7 0 0 1-14 0v-2" />
      <rect x="9" y="2" width="6" height="13" rx="3" />
    </>
  );
}

/** The weather beside the Echo's clock, one Lucide outline per sky (#432 S6, owner D1 = a: the sky says the weather). */
export function WeatherOutline({ sky }: { sky: 'mild' | 'hot' | 'dusk' | 'storm' }) {
  switch (sky) {
    case 'mild':
      // Lucide "sun".
      return (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41" />
        </>
      );
    case 'hot':
      // Lucide "thermometer-sun".
      return <path d="M12 2v2 M12 8a4 4 0 0 0-1.645 7.647 M2 12h2 M20 14.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z M4.93 4.93l1.41 1.41 M6.34 17.66l-1.41 1.41" />;
    case 'dusk':
      // Lucide "sunset".
      return <path d="M12 10V2 M4.93 10.93l1.41 1.41 M2 18h2 M20 18h2 M19.07 10.93l-1.41 1.41 M22 22H2 M16 6l-4 4-4-4 M16 18a4 4 0 0 0-8 0" />;
    case 'storm':
      // Lucide "cloud-lightning".
      return <path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973 M13 12l-3 5h4l-3 5" />;
  }
}

/** Lucide "snowflake" (ISC, see NOTICE): the settings' winter block (owner, 20 Oct). */
export function SnowflakeOutline({ className }: { className: string }) {
  return (
    <path
      d="M10 20l-1.25-2.5L6 18 M10 4L8.75 6.5 6 6 M14 20l1.25-2.5L18 18 M14 4l1.25 2.5L18 6 M17 21l-3-6h-4 M17 3l-3 6 1.5 3 M2 12h6.5L10 9 M20 10l-1.5 2 1.5 2 M22 12h-6.5L14 15 M4 10l1.5 2L4 14 M7 21l3-6-1.5-3 M7 3l3 6h4"
      className={className}
    />
  );
}
