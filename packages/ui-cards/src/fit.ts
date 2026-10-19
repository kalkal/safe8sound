// No scrolling anywhere on the Echo screen (owner, 10 Oct): the host gives the card its height (MCP Apps
// containerDimensions.maxHeight). A page taller than that is scaled down inside the card; pages keep the cards short,
// so the scale stays close to 1. Rounded down, so the scaled page never ends past the height.
// Never an unreadable thumbnail (owner, 12 Oct: a plan at 0.4 on a 1920 × 1080 screen): the scale stops at
// MIN_FIT_SCALE. A page that does not fit even there is "cramped": the card is cut at the height and offers full screen.

/** The smallest scale a card is shown at: its 14 px text stays above 11 px. */
export const MIN_FIT_SCALE = 0.8;

const known = (natural: number, maxHeight: number | undefined): maxHeight is number => maxHeight !== undefined && natural > 0 && maxHeight > 0;

/** The scale that makes a page of `natural` px fit in `maxHeight` px: 1 when it fits or nothing is known; never below MIN_FIT_SCALE. */
export function fitScale(natural: number, maxHeight: number | undefined): number {
  if (!known(natural, maxHeight) || natural <= maxHeight) return 1;
  return Math.max(MIN_FIT_SCALE, Math.floor((maxHeight / natural) * 1000) / 1000);
}

/**
 * How far the visible end of a page scaled by `scale` lies below the frame's `height`, in the page's unscaled px
 * (#371: the browser places a sticky button row in those px). Rounded down, so the row never ends past the cut.
 */
export function fitOverhang(height: number, scale: number): number {
  if (height <= 0 || scale <= 0 || scale >= 1) return 0;
  return Math.floor(height / scale - height);
}

/** True when a page of `natural` px does not fit in `maxHeight` px even at MIN_FIT_SCALE. */
export function fitCramped(natural: number, maxHeight: number | undefined): boolean {
  return known(natural, maxHeight) && natural * MIN_FIT_SCALE > maxHeight;
}

/** Below this height the giant numbers drop to their smallest size (--font-size-hero-min). */
export const TIGHT_BELOW_PX = 420;

/**
 * Below this height (a small Echo with Ana's phone beside it, 960 × 480, owner 19 Oct, mockup s6-layout-v2) the card is
 * compact: its first page alone, the other pages behind "Full screen", the chrome as small as its targets allow.
 */
export const COMPACT_BELOW_PX = 260;

/**
 * How short the frame is: tight (a small Echo, a card under tabs: the giant numbers at their smallest size before any
 * scaling), compact (also the first page alone). Without a height (full screen, a plain page) neither.
 */
export function fitFrame(maxHeight: number | undefined): { tight: boolean; compact: boolean } {
  if (maxHeight === undefined || maxHeight <= 0) return { tight: false, compact: false };
  return { tight: maxHeight < TIGHT_BELOW_PX, compact: maxHeight < COMPACT_BELOW_PX };
}
