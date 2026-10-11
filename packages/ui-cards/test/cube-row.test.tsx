// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CUBES_PER_ROW, CubeRow } from '../src/CubeRow.js';

afterEach(cleanup);

const row = () => screen.getByRole('img');
const perRow = () => row().style.getPropertyValue('--cubes-per-row');
const half = () => row().style.getPropertyValue('--cubes-half');

describe('CubeRow (the signature element, shared by the cards and the idle screen)', () => {
  it('draws one cube per hour, says them in words, and keeps one row up to CUBES_PER_ROW cubes', () => {
    render(<CubeRow hours={9.5} />);
    expect(row().querySelectorAll('.cube')).toHaveLength(12);
    expect(row().getAttribute('aria-label')).toMatch(/9½ hours/);
    expect(perRow()).toBe('12');
    expect(half()).toBe('6');
    cleanup();
    render(<CubeRow hours={CUBES_PER_ROW} />);
    expect(perRow()).toBe(String(CUBES_PER_ROW));
  });

  it('above CUBES_PER_ROW cubes wraps into two even rows, so the cubes keep their 56 px', () => {
    render(<CubeRow hours={20} />);
    expect(row().querySelectorAll('.cube')).toHaveLength(20);
    expect(perRow()).toBe('10');
    cleanup();
    render(<CubeRow hours={40} />);
    expect(perRow()).toBe('12');
  });

  it('melts only in the storm, only the cube of the hour being used', () => {
    render(<CubeRow hours={9.5} />);
    expect(row().querySelectorAll('[data-melting]')).toHaveLength(0);
    cleanup();
    render(<CubeRow hours={9.5} storm />);
    const melting = row().querySelectorAll('[data-melting="true"]');
    expect(melting).toHaveLength(1);
    expect(melting[0]?.getAttribute('data-fill')).toBe('0.5');
  });
});
