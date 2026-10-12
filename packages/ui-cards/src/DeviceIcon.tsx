// The connected devices, drawn (owner feedback, 6 Oct): inline SVG pictures beside the words, so the home reads at a
// glance. The outlines are Lucide icons (ISC licence, see NOTICE): battery, solar-panel, utility-pole, air-vent, on
// their 24 × 24 grid with one round 2 px stroke. Only the live parts are ours: the charge, the sun, the cross, the air.
// Inline only (the card CSP has no images or fetches); lines follow the text colour and the live parts use tokens, so
// both themes work. They sit beside words that already say everything, so they are hidden from screen readers.

export type Device = 'battery' | 'solar' | 'grid' | 'split';

/** The battery's inner width in the 24 × 24 grid: the charge bar is this wide at 100 %. */
export const BATTERY_CHARGE_WIDTH = 11;

export function DeviceIcon({ device, level, on }: { device: Device; /** Battery charge, 0–100. */ level?: number; /** A split blowing. */ on?: boolean }) {
  return (
    <svg className="device-icon" data-device={device} {...(on === undefined ? {} : { 'data-on': String(on) })} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {device === 'battery' && <Battery level={level ?? 0} />}
      {device === 'solar' && <Solar on={on !== false} />}
      {device === 'grid' && <Grid on={on !== false} />}
      {device === 'split' && <Split on={on === true} />}
    </svg>
  );
}

/** Lucide "battery", filled from the left as far as the charge goes. */
function Battery({ level }: { level: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  const width = (BATTERY_CHARGE_WIDTH * pct) / 100;
  return (
    <>
      <rect x="4.5" y="8.5" width={width} height="7" rx="1" className="device-charge" data-level={String(pct)} />
      <rect x="2" y="6" width="16" height="12" rx="2" className="device-line" />
      <path d="M22 14v-4" className="device-line" />
    </>
  );
}

/** Lucide "solar-panel": its sun only while the panels produce (review of #286: no sun at 0 W), in the warm accent. */
function Solar({ on }: { on: boolean }) {
  return (
    <>
      {on && <path d="M11 2h2 M3 10v2 M7 2a4 4 0 0 1-4 4 M8.66 7.66l1.41 1.41" className="device-sun" />}
      <path
        d="m14.28 14-4.56 8 M21 22l-1.558-4H4.558 M6.245 15.04A2 2 0 0 1 8 14h12a1 1 0 0 1 .864 1.505l-3.11 5.457A2 2 0 0 1 16 22H4a1 1 0 0 1-.863-1.506z"
        className="device-line"
      />
    </>
  );
}

/** Lucide "utility-pole", dimmed and crossed out while the grid is down (review of #286); the words say "Grid down" too. */
function Grid({ on }: { on: boolean }) {
  return (
    <>
      <path d="M12 2v20 M2 5h20 M3 3v2 M7 3v2 M17 3v2 M21 3v2 M19 5l-7 7-7-7" className={on ? 'device-line' : 'device-line device-off'} />
      {!on && <path d="M3 3 21 21" className="device-cross" />}
    </>
  );
}

/** Lucide "air-vent": the unit always, its two curls of air only while the room is served. */
function Split({ on }: { on: boolean }) {
  return (
    <>
      <path d="M6 12H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 8h12" className="device-line" />
      {on && <path d="M18 17.5a2.5 2.5 0 1 1-4 2.03V12 M6.6 15.572A2 2 0 1 0 10 17v-5" className="device-air" />}
    </>
  );
}
