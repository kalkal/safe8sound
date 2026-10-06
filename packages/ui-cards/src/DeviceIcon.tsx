// The connected devices, drawn (owner feedback, 6 Oct): big inline SVG pictures beside the words, so the home reads at
// a glance. Inline only (the card CSP has no images); lines follow the text colour and fills use tokens, so both themes
// work. They sit beside words that already say everything, so they are hidden from screen readers.

export type Device = 'battery' | 'solar' | 'grid' | 'split';

export function DeviceIcon({ device, level, on }: { device: Device; /** Battery charge, 0–100. */ level?: number; /** A split blowing. */ on?: boolean }) {
  return (
    <svg className="device-icon" data-device={device} {...(on === undefined ? {} : { 'data-on': String(on) })} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      {device === 'battery' && <Battery level={level ?? 0} />}
      {device === 'solar' && <Solar on={on !== false} />}
      {device === 'grid' && <Grid on={on !== false} />}
      {device === 'split' && <Split on={on === true} />}
    </svg>
  );
}

function Battery({ level }: { level: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  const height = (30 * pct) / 100;
  return (
    <>
      <rect x="18" y="3" width="12" height="5" rx="1" className="device-solid" />
      <rect x="11" y="8" width="26" height="37" rx="4" className="device-line" />
      <rect x="15" y={12 + (30 - height)} width="18" height={height} rx="2" className="device-charge" data-level={String(pct)} />
    </>
  );
}

/** The sun only while the panels produce (review of #286: no sun at 0 W). */
function Solar({ on }: { on: boolean }) {
  return (
    <>
      {on && <circle cx="39" cy="9" r="5" className="device-sun" />}
      <path d="M5 30 L13 14 H40 L32 30 Z M9 22 H36 M19 14 L15 30 M27 14 L23 30 M22 30 V41 M14 41 H30" className="device-line" />
    </>
  );
}

/** The pylon, crossed out while the grid is down (review of #286); the words say "Grid down" too. */
function Grid({ on }: { on: boolean }) {
  return (
    <>
      <path d="M24 4 L13 44 M24 4 L35 44 M16 36 H32 M18 28 H30 M20 20 H28 M7 12 H41 M7 12 V17 M41 12 V17" className={on ? 'device-line' : 'device-line device-off'} />
      {!on && <path d="M6 6 L42 42" className="device-cross" />}
    </>
  );
}

function Split({ on }: { on: boolean }) {
  return (
    <>
      <rect x="4" y="8" width="40" height="16" rx="4" className="device-line" />
      <path d="M10 19 H38" className="device-line" />
      {on && <path d="M14 30 q4 4 0 9 M24 30 q4 4 0 9 M34 30 q4 4 0 9" className="device-air" />}
    </>
  );
}
