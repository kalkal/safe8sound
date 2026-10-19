import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The project icon (owner, 19 Oct): the page names it in every form a browser asks for, each file is served from the
// page's own origin (the CSP allows images from 'self' only), and the SVGs draw no script and no outside image. The
// favicon carries one style, its dark-tab colours (prefers-color-scheme), and no S (unreadable at tab size).

const app = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', app), 'utf8');
const svg = (file: string) => readFileSync(new URL(`public/${file}`, app), 'utf8');
const outside = /<script|<image|<foreignObject|href=|url\((?!#)|@import/;

describe('favicon', () => {
  it('the page links the SVG, the 32 and 16 px PNGs and the touch icon, each a file of public/', () => {
    const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="\/([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(['favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png']);
    for (const file of links) expect(existsSync(new URL(`public/${file ?? ''}`, app)), file).toBe(true);
  });

  it('the favicon is a drawing whose only style is its dark-tab variant', () => {
    const favicon = svg('favicon.svg');
    expect(favicon).not.toMatch(outside);
    const styles = [...favicon.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
    expect(styles).toHaveLength(1);
    expect(styles[0]).toContain('@media (prefers-color-scheme: dark)');
    expect(favicon).not.toMatch(/<mask/);
  });

  it('the mark beside the title sits on the dark bezel: the light tower, no style at all', () => {
    const mark = svg('mark-on-dark.svg');
    expect(mark).not.toMatch(outside);
    expect(mark).not.toMatch(/<style|class=/);
    expect(mark).toContain('#f6f1e7');
  });
});
