import { AirVentAir, AirVentUnit, BatteryOutline, Cross, IconFrame, SolarPanelOutline, SolarSun, UtilityPoleOutline } from './icons.js';

// The connected devices, drawn (owner feedback, 6 Oct): inline SVG pictures beside the words, so the home reads at a
// glance. The outlines (Lucide battery, solar-panel, utility-pole, air-vent) live in icons.tsx; only the live parts
// are decided here: the charge, the sun, the cross, the air. Lines follow the text colour and the live parts use
// tokens, so both themes work. They sit beside words that already say everything, so they are hidden from screen
// readers.

export type Device = 'battery' | 'solar' | 'grid' | 'split';

/** The battery's inner width in the 24 × 24 grid: the charge bar is this wide at 100 %. */
export const BATTERY_CHARGE_WIDTH = 11;

export function DeviceIcon({ device, level, on }: { device: Device; /** Battery charge, 0–100. */ level?: number; /** A split blowing. */ on?: boolean }) {
  return (
    <IconFrame className="device-icon" data={{ device, ...(on === undefined ? {} : { on: String(on) }) }}>
      {device === 'battery' && <Battery level={level ?? 0} />}
      {device === 'solar' && <Solar on={on !== false} />}
      {device === 'grid' && <Grid on={on !== false} />}
      {device === 'split' && <Split on={on === true} />}
    </IconFrame>
  );
}

/** Lucide "battery", filled from the left as far as the charge goes. */
function Battery({ level }: { level: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  const width = (BATTERY_CHARGE_WIDTH * pct) / 100;
  return (
    <>
      <rect x="4.5" y="8.5" width={width} height="7" rx="1" className="device-charge" data-level={String(pct)} />
      <BatteryOutline className="device-line" />
    </>
  );
}

/** Lucide "solar-panel": its sun only while the panels produce (review of #286: no sun at 0 W), in the warm accent. */
function Solar({ on }: { on: boolean }) {
  return (
    <>
      {on && <SolarSun className="device-sun" />}
      <SolarPanelOutline className="device-line" />
    </>
  );
}

/** Lucide "utility-pole", dimmed and crossed out while the grid is down (review of #286); the words say "Grid down" too. */
function Grid({ on }: { on: boolean }) {
  return (
    <>
      <UtilityPoleOutline className={on ? 'device-line' : 'device-line device-off'} />
      {!on && <Cross className="device-cross" />}
    </>
  );
}

/** Lucide "air-vent": the unit always, its two curls of air only while the room is served. */
function Split({ on }: { on: boolean }) {
  return (
    <>
      <AirVentUnit className="device-line" />
      {on && <AirVentAir className="device-air" />}
    </>
  );
}
