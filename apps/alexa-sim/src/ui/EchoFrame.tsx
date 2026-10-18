import type { ReactNode } from 'react';
import { SKIES, type Sky } from './sky.js';

// The Echo Show frame (design analysis G1, G2; plan §11.1): the simulator is the screen of a device, its
// wallpaper a sky that follows the scenario weather (sky.ts), the family phone beside it. The cards keep the
// Amazon style on top of the sky. The four skies are stacked and only the current one is shown, so a change
// fades (≥ 1 s, still with reduced motion). Below the device width the bezel goes and the sky stays.

export interface EchoFrameProps {
  sky: Sky;
  children: ReactNode;
  /** Beside the device: the family member's phone. */
  aside?: ReactNode;
  /** Above the device, outside its screen: the scenario badge (B1). */
  top?: ReactNode;
  /** Under the device, outside its screen: the simulated clock (#391). */
  dock?: ReactNode;
}

export function EchoFrame({ sky, children, aside, top, dock }: EchoFrameProps) {
  return (
    <div className="echo-stage">
      {top !== undefined && <div className="echo-top">{top}</div>}
      <div className="echo-column">
        <div className="echo-device">
          <div className="echo-screen" data-testid="echo-screen" data-sky={sky}>
            <div className="sky" aria-hidden="true" data-slot="background" data-testid="slot-background">
              {SKIES.map((s) => (
                <div key={s} className="sky-layer" data-layer={s} data-shown={s === sky} />
              ))}
            </div>
            <div className="echo-scroll" data-testid="screen-viewport">
              <main className="surface">{children}</main>
            </div>
          </div>
        </div>
        {dock}
      </div>
      {aside}
    </div>
  );
}
