// No scrolling anywhere on the Echo screen (owner, 10 Oct): the host gives the card its height (MCP Apps
// containerDimensions.maxHeight). A page taller than that is scaled down inside the card; pages keep the cards short,
// so the scale stays close to 1. Rounded down, so the scaled page never ends past the height.

/** The scale that makes a page of `natural` px fit in `maxHeight` px: 1 when it fits or when nothing is known yet. */
export function fitScale(natural: number, maxHeight: number | undefined): number {
  if (maxHeight === undefined || !(natural > 0) || !(maxHeight > 0) || natural <= maxHeight) return 1;
  return Math.floor((maxHeight / natural) * 1000) / 1000;
}
