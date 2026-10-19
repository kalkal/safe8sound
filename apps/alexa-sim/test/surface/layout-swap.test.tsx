// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_IDS } from '../../src/surface/contract.js';
import { LAYOUTS } from '../../src/surface/registry.js';

// The swap (#432): the same slots under each layout give the same buttons and the same words; only the look changes.
// Every id in LAYOUT_IDS has a layout in the registry, so a configured id always draws something.

afterEach(cleanup);

const slots = {
  screen: (
    <>
      <p>Leo&apos;s room stays safe until 06:40.</p>
      <button type="button">Ask</button>
    </>
  ),
  demoControls: <button type="button">Demo controls</button>,
  companion: <section aria-label="Phone">Storm at home</section>,
};

function drawn(id: (typeof LAYOUT_IDS)[number]) {
  const Layout = LAYOUTS[id];
  render(<Layout slots={slots} state={{ sky: 'storm', screen: 'idle' }} />);
  const result = { buttons: screen.getAllByRole('button').map((b) => b.textContent), main: screen.getByRole('main').textContent, phone: screen.getByRole('region', { name: 'Phone' }).textContent };
  cleanup();
  return result;
}

describe('layout swap', () => {
  it('every layout id has a layout, and each shows the same content', () => {
    expect(Object.keys(LAYOUTS).sort()).toEqual([...LAYOUT_IDS].sort());
    const [first, ...others] = LAYOUT_IDS.map(drawn);
    for (const other of others) expect(other).toEqual(first);
  });
});
