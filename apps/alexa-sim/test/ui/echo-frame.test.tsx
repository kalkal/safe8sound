// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EchoFrame } from '../../src/ui/EchoFrame.js';

// The Echo Show frame (design analysis G1, G2): the simulator inside a device, on a sky that follows the weather.

afterEach(cleanup);

describe('EchoFrame', () => {
  it('shows the sky it is given on the screen, with the page as the main landmark inside it', () => {
    render(
      <EchoFrame sky="storm">
        <p>content</p>
      </EchoFrame>,
    );
    const screenEl = screen.getByTestId('echo-screen');
    expect(screenEl.dataset['sky']).toBe('storm');
    expect(screenEl.contains(screen.getByRole('main'))).toBe(true);
    expect(screen.getByRole('main').textContent).toBe('content');
  });

  it('draws the four skies as decoration, only the current one shown, so a change can fade', () => {
    const { container } = render(<EchoFrame sky="hot">x</EchoFrame>);
    const layers = [...container.querySelectorAll<HTMLElement>('.sky-layer')];
    expect(layers.map((l) => [l.dataset['layer'], l.dataset['shown']])).toEqual([
      ['mild', 'false'],
      ['hot', 'true'],
      ['dusk', 'false'],
      ['storm', 'false'],
    ]);
    expect(container.querySelector('.sky')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('names its background slot and its scroll area with the test ids the specs read, inside the screen', () => {
    render(<EchoFrame sky="mild">x</EchoFrame>);
    const screenEl = screen.getByTestId('echo-screen');
    const background = screen.getByTestId('slot-background');
    expect(background.dataset['slot']).toBe('background');
    expect(screenEl.contains(background)).toBe(true);
    expect(screen.getByTestId('screen-viewport').contains(screen.getByRole('main'))).toBe(true);
  });

  it('puts the family phone beside the device, outside the screen', () => {
    render(
      <EchoFrame sky="mild" aside={<section aria-label="Phone">phone</section>}>
        x
      </EchoFrame>,
    );
    expect(screen.getByTestId('echo-screen').contains(screen.getByRole('region', { name: 'Phone' }))).toBe(false);
  });
});
