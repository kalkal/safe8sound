// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_KINDS, Avatar } from '../src/avatars.js';

// The drawn avatars of the household (#432 S3): hand-drawn inline SVG, never a photo. The card and site CSP allows
// inline SVG but no <style>, no style attribute and no external <image>; ids would clash when the same avatar is
// drawn twice on one page. A person's avatar sits beside their name, so screen readers skip it; the house (no one at
// risk at home, 20 Oct) has no name beside it and says what it means. It lives under its
// own export path, so the card bundle (6.5 kB under its budget) never carries it.

afterEach(cleanup);

// jsdom replaces the URL class, so the paths are built from the module's file path.
const here = fileURLToPath(new globalThis.URL('.', import.meta.url));
const src = (file: string) => readFileSync(join(here, '..', 'src', file), 'utf8');

describe('Avatar', () => {
  for (const kind of AVATAR_KINDS) {
    it(`${kind}: one inline SVG, never focusable; a person is hidden from screen readers (their name is beside it), the house says what it means`, () => {
      const { container } = render(<Avatar kind={kind} className="who" />);
      const svgs = container.querySelectorAll('svg');
      expect(svgs).toHaveLength(1);
      const svg = svgs[0];
      expect(svg?.getAttribute('class')).toBe('avatar who');
      expect(svg?.getAttribute('data-avatar')).toBe(kind);
      if (kind === 'home') {
        expect(svg?.getAttribute('role')).toBe('img');
        expect(svg?.getAttribute('aria-label')).toBe('No one at risk at home');
      } else expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('focusable')).toBe('false');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 64 64');
    });

    it(`${kind}: nothing the CSP blocks and no ids that clash`, () => {
      const { container } = render(<Avatar kind={kind} />);
      expect(container.querySelector('style, image, foreignObject, script, use, [style], [id], [href]')).toBeNull();
      expect(container.innerHTML).not.toMatch(/https?:|url\(/);
    });

    it(`${kind}: every shape takes its color from a class, so the colors are tokens`, () => {
      const { container } = render(<Avatar kind={kind} />);
      const shapes = [...container.querySelectorAll('svg *')];
      expect(shapes.length).toBeGreaterThan(5);
      for (const shape of shapes) {
        expect(shape.getAttribute('class'), shape.outerHTML).toMatch(/^avatar-(disc|skin|hair|clothes|line)$/);
        expect(shape.hasAttribute('fill') || shape.hasAttribute('stroke'), shape.outerHTML).toBe(false);
      }
    });
  }

  it('draws each kind differently', () => {
    const drawn = AVATAR_KINDS.map((kind) => render(<Avatar kind={kind} />).container.innerHTML);
    expect(new Set(drawn).size).toBe(AVATAR_KINDS.length);
  });

  it('the older man wears glasses and a moustache; the woman has long hair and no glasses', () => {
    const man = render(<Avatar kind="older-man" />).container;
    const woman = render(<Avatar kind="adult-woman" />).container;
    expect(man.querySelectorAll('circle.avatar-line').length).toBeGreaterThanOrEqual(2);
    expect(woman.querySelectorAll('circle.avatar-line')).toHaveLength(0);
    expect(woman.querySelectorAll('.avatar-hair').length).toBeGreaterThanOrEqual(2);
  });

  it('stays out of the card bundle: its own export path, never re-exported by the index', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./avatars']).toBe('./src/avatars.tsx');
    expect(pkg.exports['./avatars.css']).toBe('./src/avatars.css');
    expect(src('index.ts')).not.toMatch(/avatars/);
  });

  it('colors every class from a semantic token, the same in both themes like the sky', () => {
    const css = src('avatars.css');
    for (const part of ['disc', 'skin', 'line']) expect(css).toMatch(new RegExp(`\\.avatar-${part}\\s*\\{[^}]*var\\(--avatar-${part}\\)`));
    for (const kind of AVATAR_KINDS) {
      expect(css).toMatch(new RegExp(`\\[data-avatar='${kind}'\\] \\.avatar-hair\\s*\\{[^}]*var\\(--avatar-hair-`));
      expect(css).toMatch(new RegExp(`\\[data-avatar='${kind}'\\] \\.avatar-clothes\\s*\\{[^}]*var\\(--avatar-clothes-`));
    }
  });
});

describe('Avatar beside a text that says the same', () => {
  it('the house is hidden from screen readers when it is decorative (Who we protect says "No one at risk at home")', () => {
    const svg = render(<Avatar kind="home" decorative />).container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.hasAttribute('role')).toBe(false);
    expect(svg?.hasAttribute('aria-label')).toBe(false);
  });
});
