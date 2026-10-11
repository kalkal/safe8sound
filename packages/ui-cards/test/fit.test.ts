import { describe, expect, it } from 'vitest';
import { fitScale } from '../src/fit.js';

// No scrolling anywhere on the Echo screen (owner, 10 Oct): the host gives the card its height (MCP Apps
// containerDimensions.maxHeight); a page taller than that is scaled down inside the card, a page that fits never is.

describe('fitScale', () => {
  it('a page that fits, or no height given (full screen, a plain page), keeps its size', () => {
    expect(fitScale(300, 400)).toBe(1);
    expect(fitScale(400, 400)).toBe(1);
    expect(fitScale(300, undefined)).toBe(1);
  });

  it('a taller page is scaled so it ends inside the height, never past it', () => {
    expect(fitScale(800, 400)).toBe(0.5);
    expect(fitScale(588, 157) * 588).toBeLessThanOrEqual(157);
    expect(fitScale(588, 157)).toBeGreaterThan(0.26);
  });

  it('nothing measured yet keeps its size', () => {
    expect(fitScale(0, 400)).toBe(1);
    expect(fitScale(300, 0)).toBe(1);
  });
});
