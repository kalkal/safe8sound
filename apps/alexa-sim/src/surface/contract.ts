import type { ComponentType, ReactNode } from 'react';
import type { Sky } from '../ui/sky.js';

// The device layout is a template another can replace (owner, 18 Oct; #432). A layout places named slots it is given
// and never knows what is in them; the session, the data and the voice stay out of it (depcruise:
// logic-never-imports-layouts, layouts-are-presentational, layouts-do-not-import-each-other). Choosing Alexa or,
// after 23 Oct, a Google Home panel for the real home is a config value, never a code path.

/** Every layout that exists. `google-nest-hub` comes after 23 Oct, for the real home only. */
export const LAYOUT_IDS = ['alexa-echo-show', 'plain'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
/** The judges' site is an Amazon contest: it always shows the Alexa layout (the AWS build assigns it). */
export const DEFAULT_LAYOUT: LayoutId = 'alexa-echo-show';

/** The named places a layout fills. `screen` is the device's screen (the conversation's three bands today). */
export interface SurfaceSlots {
  readonly screen: ReactNode;
  /** The judges' demo controls, outside the screen; removable by config. */
  readonly demoControls?: ReactNode;
  /** The simulated clock, outside the screen. */
  readonly clock?: ReactNode;
  /** Beside the device: the family member's phone. */
  readonly companion?: ReactNode;
}

/** What the layout may show about the moment, never the data behind it. */
export interface SurfaceState {
  /** The weather of the moment, for the background. */
  readonly sky: Sky;
}

export type SurfaceLayout = ComponentType<{ slots: SurfaceSlots; state: SurfaceState }>;

/**
 * The test ids every layout writes, so the specs never name a layout's own classes (e2e/surface.ts): the background
 * and the screen's scroll area (which never scrolls). The bands inside the screen write slot-head, slot-content and
 * slot-actions themselves.
 */
export const SLOT_TEST_IDS = { background: 'slot-background', viewport: 'screen-viewport' } as const;
