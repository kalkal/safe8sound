import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The "Full screen" / "Back to the conversation" button sits at the frame's edge (body has no margin), and the
// card document does not include base.css: a default outside focus ring would be clipped by the frame.

const cards = readFileSync(new URL('../src/cards.css', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector list contains `selector`. */
function ruleBody(source: string, selector: string): string | undefined {
  const at = source.indexOf(selector);
  if (at < 0) return undefined;
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

describe('focus ring on the display toggle', () => {
  it('draws the token outline inside the button, so the frame edge never clips it', () => {
    const body = ruleBody(cards, '.display-toggle .card-expand:focus-visible');
    expect(body).toBeDefined();
    expect(body).toMatch(/outline:\s*calc\(var\(--border-thin\) \* 3\) solid var\(--focus-ring\)/);
    expect(body).toMatch(/outline-offset:\s*calc\(var\(--border-thin\) \* -\d+\)/);
  });
});
