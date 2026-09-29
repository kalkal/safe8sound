// @vitest-environment jsdom
import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IceCubesCard, cubeFills } from '../src/IceCubesCard.js';

afterEach(cleanup);

const outlook = (patch: Partial<ReturnType<typeof exampleReserveOutlook>> = {}) =>
  ReserveOutlookSchema.parse({ ...exampleReserveOutlook(), ...patch });

describe('cubeFills (one cube = one hour at the current level)', () => {
  it('fills whole cubes, then the part of the last hour, and shows at least 12 cubes', () => {
    expect(cubeFills(9.5)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0, 0]);
    expect(cubeFills(0)).toHaveLength(12);
    expect(cubeFills(14.25)).toHaveLength(15);
  });

  it('caps the row at 24 cubes, a full day', () => {
    expect(cubeFills(40)).toHaveLength(24);
  });
});

describe('IceCubesCard', () => {
  it('says the hours on battery alone at the current level, with the SIMULATED badge', () => {
    render(<IceCubesCard outlook={outlook()} />);
    expect(screen.getByTestId('cube-hours').textContent).toBe('9½ h');
    expect(screen.getByText('on battery alone at Comfort. One cube is one hour at the current level.')).toBeTruthy();
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
  });

  it('describes the cubes in words for screen readers', () => {
    render(<IceCubesCard outlook={outlook()} />);
    const cubes = screen.getByRole('img', { name: '9½ hours: 9 full cubes and part of one more.' });
    expect(cubes.querySelectorAll('[data-fill]')).toHaveLength(12);
  });

  it('says what is drawn, with singular and plural, and stays true beyond the 24 cubes shown', () => {
    const name = (hours: number) => {
      render(<IceCubesCard outlook={outlook({ hoursAtCurrentLevel: hours, hoursAtEssential: Math.max(hours, 18) })} />);
      const label = screen.getByRole('img').getAttribute('aria-label');
      cleanup();
      return label;
    };
    expect(name(1)).toBe('1 hour: 1 full cube.');
    expect(name(1.5)).toBe('1½ hours: 1 full cube and part of one more.');
    expect(name(0.5)).toBe('½ hour: part of one cube.');
    expect(name(12)).toBe('12 hours: 12 full cubes.');
    expect(name(40)).toBe('40 hours: 24 full cubes shown, one per hour up to a day.');
  });

  it('explains that a lower level makes each cube last longer, except at Essential', () => {
    render(<IceCubesCard outlook={outlook()} />);
    expect(screen.getByText('If the level drops, each cube lasts longer: at Essential the same energy lasts about 18 h.')).toBeTruthy();
    cleanup();
    render(<IceCubesCard outlook={outlook({ level: 'essential', hoursAtCurrentLevel: 18 })} />);
    expect(screen.queryByText(/If the level drops/)).toBeNull();
  });
});
