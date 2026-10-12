// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IconFrame, LanguagesOutline, SmartphoneOutline } from '../src/icons.js';

// One home for the icon outlines (architecture review): the frame hides every icon from screen readers, and the
// Lucide outlines keep the path data of lucide-static 1.55.0 (credited in NOTICE).

afterEach(cleanup);

describe('icons', () => {
  it('the frame is the 24 × 24 grid, hidden from screen readers, never focusable, with its data attributes', () => {
    const { container } = render(
      <IconFrame className="x" data={{ device: 'phone' }}>
        <SmartphoneOutline className="line" />
      </IconFrame>,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.getAttribute('data-device')).toBe('phone');
    expect(container.querySelectorAll('.line')).toHaveLength(2);
  });

  it('"languages" is the Lucide outline', () => {
    const { container } = render(
      <svg>
        <LanguagesOutline />
      </svg>,
    );
    expect(container.querySelector('path')?.getAttribute('d')).toBe('m5 8 6 6 M4 14l6-6 2-3 M2 5h12 M7 2h1 M22 22l-5-10-5 10 M14 18h6');
  });
});
