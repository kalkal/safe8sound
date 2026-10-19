import { useEffect, useRef } from 'react';
import type { SurfaceLayout } from '../../surface/contract.js';
import { SLOT_TEST_IDS } from '../../surface/contract.js';
import { SKIES } from '../../ui/sky.js';
import './layout.css';

// The Alexa Echo Show layout (design analysis G1, G2; plan §11.1; #432): the simulator is the screen of a device, its
// wallpaper a sky that follows the scenario weather (sky.ts), the family phone beside it. The cards keep the Amazon
// style on top of the sky. The four skies are stacked and only the current one is shown, so a change fades (≥ 1 s,
// still with reduced motion). Below the device width the bezel goes and the sky stays. The top bar sits above the
// device, the simulated clock and the judges' question bar in one row under the device and the phone, the judges' demo
// controls a sheet behind a button of the top bar (owner, 19 Oct); none of them inside its screen.

/**
 * The width the screen's content is drawn for (#432 S6, owner 19 Oct: "the real Echo as it appears, at the right size").
 * The device is scaled to fit the window and never re-proportioned, and what is on its screen scales with it, as on a
 * smaller or larger Echo: the screen's content is zoomed by its width over this one.
 */
export const SCREEN_DESIGN_WIDTH_PX = 960;

/** Keeps --screen-zoom on the screen equal to its width over the design width; 1 where the screen is the window (a phone). */
function useScreenZoom() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const screen = ref.current;
    if (screen === null || typeof ResizeObserver === 'undefined') return undefined;
    // The width from which layout.css draws the device with its bezel (this layout's own breakpoint, the same 48rem as its
    // CSS; Ana's phone column happens to start there too, PHONE_BESIDE, by the owner's choice of 19 Oct).
    const device = window.matchMedia('(width >= 48rem)');
    const measure = () => {
      const zoom = device.matches ? screen.getBoundingClientRect().width / SCREEN_DESIGN_WIDTH_PX : 1;
      screen.style.setProperty('--screen-zoom', zoom.toFixed(3));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    device.addEventListener('change', measure);
    measure();
    return () => {
      observer.disconnect();
      device.removeEventListener('change', measure);
    };
  }, []);
  return ref;
}

export const EchoShowLayout: SurfaceLayout = ({ slots, state }) => {
  const screenRef = useScreenZoom();
  return (
    <div className="echo-stage" data-layout="alexa-echo-show">
      {slots.topBar !== undefined && <div className="echo-top">{slots.topBar}</div>}
      {slots.demoControls !== undefined && <div className="echo-controls">{slots.demoControls}</div>}
      <div className="echo-column">
        <div className="echo-device">
          <div ref={screenRef} className="echo-screen" data-testid="echo-screen" data-sky={state.sky} data-screen={state.screen}>
            <div className="sky" aria-hidden="true" data-slot="background" data-testid={SLOT_TEST_IDS.background}>
              {SKIES.map((s) => (
                <div key={s} className="sky-layer" data-layer={s} data-shown={s === state.sky} />
              ))}
            </div>
            <div className="echo-scroll" data-testid={SLOT_TEST_IDS.viewport}>
              <main className="surface">{slots.screen}</main>
            </div>
          </div>
        </div>
      </div>
      {slots.companion}
      {/* Under the device and the phone, one row: the simulated clock and the judges' question bar (#432 S6). */}
      {(slots.clock !== undefined || slots.askBar !== undefined) && (
        <div className="echo-under">
          {slots.clock}
          {slots.askBar}
        </div>
      )}
    </div>
  );
};
