// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EchoShowLayout } from '../../src/layouts/alexa-echo-show/EchoShowLayout.js';
import { describeSurfaceLayoutContract } from '../surface/surface-layout-contract.js';

// The Alexa Echo Show layout (design analysis G1, G2): the simulator inside a device, on a sky that follows the weather.

describeSurfaceLayoutContract('alexa-echo-show', EchoShowLayout);

afterEach(cleanup);

describe('EchoShowLayout', () => {
  it('shows the sky it is given on the screen, with the page as the main landmark inside it', () => {
    render(<EchoShowLayout slots={{ screen: <p>content</p> }} state={{ sky: 'storm' }} />);
    const screenEl = screen.getByTestId('echo-screen');
    expect(screenEl.dataset['sky']).toBe('storm');
    expect(screenEl.contains(screen.getByRole('main'))).toBe(true);
    expect(screenEl.contains(screen.getByTestId('slot-background'))).toBe(true);
  });

  it('draws the four skies as decoration, only the current one shown, so a change can fade', () => {
    const { container } = render(<EchoShowLayout slots={{ screen: 'x' }} state={{ sky: 'hot' }} />);
    const layers = [...container.querySelectorAll<HTMLElement>('[data-layer]')];
    expect(layers.map((l) => [l.dataset['layer'], l.dataset['shown']])).toEqual([
      ['mild', 'false'],
      ['hot', 'true'],
      ['dusk', 'false'],
      ['storm', 'false'],
    ]);
    expect(screen.getByTestId('slot-background').getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the family phone beside the device and the judges\' controls above it, both outside the screen', () => {
    render(<EchoShowLayout slots={{ screen: 'x', companion: <section aria-label="Phone">phone</section>, demoControls: <button type="button">Demo controls</button> }} state={{ sky: 'mild' }} />);
    const screenEl = screen.getByTestId('echo-screen');
    expect(screenEl.contains(screen.getByRole('region', { name: 'Phone' }))).toBe(false);
    expect(screenEl.contains(screen.getByRole('button', { name: 'Demo controls' }))).toBe(false);
  });
});
