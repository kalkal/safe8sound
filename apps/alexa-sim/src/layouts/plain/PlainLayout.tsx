import type { SurfaceLayout } from '../../surface/contract.js';
import { SLOT_TEST_IDS } from '../../surface/contract.js';
import './layout.css';

// The minimal layout (#432): no device, no sky, the same slots one under the other. It proves another layout can
// replace the Alexa one with no change to the logic (the swap test, and `?layout=plain` in dev); never on the judges'
// site, where the AWS build assigns the Alexa layout.

export const PlainLayout: SurfaceLayout = ({ slots, state }) => (
  <div className="plain-stage" data-layout="plain" data-sky={state.sky}>
    <div data-slot="background" data-testid={SLOT_TEST_IDS.background} />
    {slots.topBar !== undefined && <div className="plain-top">{slots.topBar}</div>}
    {slots.demoControls !== undefined && <div className="plain-controls">{slots.demoControls}</div>}
    <div className="plain-viewport" data-testid={SLOT_TEST_IDS.viewport}>
      <main className="surface">{slots.screen}</main>
    </div>
    {slots.clock}
    {slots.companion}
  </div>
);
