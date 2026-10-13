import { describe, expect, it } from 'vitest';
import { MIN_FIT_SCALE, fitCramped, fitOverhang, fitScale } from '../src/fit.js';

// No scrolling anywhere on the Echo screen (owner, 10 Oct): the host gives the card its height (MCP Apps
// containerDimensions.maxHeight); a page taller than that is scaled down inside the card, a page that fits never is.
// A card is never shrunk into an unreadable thumbnail (owner, 12 Oct): below MIN_FIT_SCALE the page is "cramped".

describe('fitScale', () => {
  it('a page that fits, or no height given (full screen, a plain page), keeps its size', () => {
    expect(fitScale(300, 400)).toBe(1);
    expect(fitScale(400, 400)).toBe(1);
    expect(fitScale(300, undefined)).toBe(1);
  });

  it('a slightly taller page is scaled so it ends inside the height, never past it', () => {
    expect(fitScale(450, 400) * 450).toBeLessThanOrEqual(400);
    expect(fitScale(450, 400)).toBeGreaterThan(0.88);
  });

  it('a much taller page is never shrunk below the readable scale (the 12 Oct thumbnail)', () => {
    expect(MIN_FIT_SCALE).toBeGreaterThanOrEqual(0.8);
    expect(fitScale(800, 400)).toBe(MIN_FIT_SCALE);
    expect(fitScale(674, 39)).toBe(MIN_FIT_SCALE);
  });

  it('nothing measured yet keeps its size', () => {
    expect(fitScale(0, 400)).toBe(1);
    expect(fitScale(300, 0)).toBe(1);
  });
});

// #371: a cut page keeps its button row at the frame's bottom edge. The browser places that sticky row in the page's
// unscaled pixels, so it is lowered by what the scaled page shows beyond the frame's own height.
describe('fitOverhang', () => {
  it('is the visible height in unscaled pixels minus the frame height, rounded down so the row never ends past the cut', () => {
    expect(fitOverhang(300, 0.8)).toBe(75);
    expect(fitOverhang(142, 0.8)).toBe(35);
    expect(fitOverhang(142, 0.8) * 0.8 + 142 * 0.8).toBeLessThanOrEqual(142);
  });

  it('is 0 at full size or with nothing measured', () => {
    expect(fitOverhang(300, 1)).toBe(0);
    expect(fitOverhang(0, 0.8)).toBe(0);
    expect(fitOverhang(300, 0)).toBe(0);
  });
});

describe('fitCramped', () => {
  it('a page that fits at the readable scale is not cramped', () => {
    expect(fitCramped(300, 400)).toBe(false);
    expect(fitCramped(450, 400)).toBe(false);
    expect(fitCramped(500, 400)).toBe(false);
  });

  it('a page that does not fit even at the readable scale is cramped', () => {
    expect(fitCramped(501, 400)).toBe(true);
    expect(fitCramped(674, 272)).toBe(true);
  });

  it('nothing known (full screen, nothing measured) is never cramped', () => {
    expect(fitCramped(800, undefined)).toBe(false);
    expect(fitCramped(0, 400)).toBe(false);
    expect(fitCramped(800, 0)).toBe(false);
  });
});
