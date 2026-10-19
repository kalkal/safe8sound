import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutId, SurfaceLayout } from '../../src/surface/contract.js';

// What every device layout must do (#432), run against each one: it places the slots it is given, each once, and
// never loses one; the screen is the page's main landmark and its own scroll area; the judges' controls, the clock
// and the family phone stay outside the screen; it writes the test ids the specs read (e2e/surface.ts).

const slots = {
  screen: <button type="button">Ask</button>,
  topBar: <button type="button">Settings</button>,
  demoControls: <button type="button">Demo controls</button>,
  clock: <div role="group" aria-label="Simulated time" />,
  companion: <section aria-label="Phone">phone</section>,
};

export function describeSurfaceLayoutContract(id: LayoutId, Layout: SurfaceLayout): void {
  describe(`${id}: the surface layout contract`, () => {
    afterEach(cleanup);

    it('places every slot once, the screen inside the main landmark and its scroll area, the rest outside it', () => {
      const { container } = render(<Layout slots={slots} state={{ sky: 'storm' }} />);
      expect(container.querySelector(`[data-layout="${id}"]`)).not.toBeNull();
      const main = screen.getByRole('main');
      const viewport = screen.getByTestId('screen-viewport');
      expect(within(main).getByRole('button', { name: 'Ask' })).toBeTruthy();
      expect(viewport.contains(main)).toBe(true);
      for (const outside of [screen.getByRole('button', { name: 'Settings' }), screen.getByRole('button', { name: 'Demo controls' }), screen.getByRole('group', { name: 'Simulated time' }), screen.getByRole('region', { name: 'Phone' })]) {
        expect(viewport.contains(outside)).toBe(false);
      }
      expect(screen.getAllByRole('button')).toHaveLength(3);
      expect(screen.getByTestId('slot-background').dataset['slot']).toBe('background');
    });

    it('leaves out the slots it is not given (the real home has no demo controls)', () => {
      render(<Layout slots={{ screen: <p>only the screen</p> }} state={{ sky: 'mild' }} />);
      expect(screen.getByRole('main').textContent).toBe('only the screen');
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
}
