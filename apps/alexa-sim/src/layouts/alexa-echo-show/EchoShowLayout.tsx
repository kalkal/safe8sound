import type { SurfaceLayout } from '../../surface/contract.js';
import { SLOT_TEST_IDS } from '../../surface/contract.js';
import { SKIES } from '../../ui/sky.js';
import './layout.css';

// The Alexa Echo Show layout (design analysis G1, G2; plan §11.1; #432): the simulator is the screen of a device, its
// wallpaper a sky that follows the scenario weather (sky.ts), the family phone beside it. The cards keep the Amazon
// style on top of the sky. The four skies are stacked and only the current one is shown, so a change fades (≥ 1 s,
// still with reduced motion). Below the device width the bezel goes and the sky stays. The judges' demo controls sit
// above the device and the simulated clock under it, both outside its screen.

export const EchoShowLayout: SurfaceLayout = ({ slots, state }) => (
  <div className="echo-stage" data-layout="alexa-echo-show">
    {slots.demoControls !== undefined && <div className="echo-top">{slots.demoControls}</div>}
    <div className="echo-column">
      <div className="echo-device">
        <div className="echo-screen" data-testid="echo-screen" data-sky={state.sky}>
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
      {slots.clock}
    </div>
    {slots.companion}
  </div>
);
