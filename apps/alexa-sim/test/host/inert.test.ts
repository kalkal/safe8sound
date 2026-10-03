// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { makeRestInert } from '../../src/host/inert.js';

// A full-screen card is a modal dialog (#206 review): the rest of the page is inert while it shows, so Tab and
// clicks never reach the Ask box or another card under it. Back restores exactly what it changed.

afterEach(() => {
  document.body.innerHTML = '';
});

describe('makeRestInert', () => {
  it('makes everything but the frame and its ancestors inert, and restores only what it set', () => {
    document.body.innerHTML = `
      <header id="title"></header>
      <main id="main">
        <section id="answers"><div id="frame-host"></div><div id="other-frame"></div></section>
        <form id="ask"></form>
      </main>
      <aside id="phone" inert></aside>`;
    const host = document.getElementById('frame-host');
    if (host === null) throw new Error('no host');
    const restore = makeRestInert(host);
    const inert = (id: string) => document.getElementById(id)?.hasAttribute('inert');
    expect(['title', 'other-frame', 'ask', 'phone'].map(inert)).toEqual([true, true, true, true]);
    expect(['frame-host', 'answers', 'main'].map(inert)).toEqual([false, false, false]);
    restore();
    expect(['title', 'other-frame', 'ask'].map(inert)).toEqual([false, false, false]);
    // It was inert before: it stays inert.
    expect(inert('phone')).toBe(true);
  });
});
