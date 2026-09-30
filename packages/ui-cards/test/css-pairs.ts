// Test helper: reads the card CSS (with native nesting) and lists [text colour, background] token pairs.
// A block that sets a colour pairs it with its own background, or with both card surfaces.
// A block that sets only a background pairs it with the colour it inherits (nearest ancestor, else the
// page text colour). Decorative pseudo-elements without text (`content: ""`) are skipped.

const CARD_SURFACES = ['surface-card', 'surface-card-raised'];
const PAGE_TEXT = 'text-primary';

interface Block {
  declarations: string;
  parent: Block | undefined;
}

const tokenOf = (declarations: string, property: RegExp): string | undefined => property.exec(declarations)?.[1];
const colorOf = (d: string) => tokenOf(d, /(?:^|[;\s{])color:\s*var\(--([a-z0-9-]+)\)/);
const backgroundOf = (d: string) => tokenOf(d, /(?:^|[;\s{])background(?:-color)?:\s*var\(--([a-z0-9-]+)\)/);

function parse(source: string): Block[] {
  const blocks: Block[] = [];
  const root: Block = { declarations: '', parent: undefined };
  let current = root;
  let text = '';
  for (const char of source.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      // Text before a nested rule: declarations of the current block, then the nested selector.
      const cut = text.lastIndexOf(';');
      current.declarations += text.slice(0, cut + 1);
      const block: Block = { declarations: '', parent: current };
      blocks.push(block);
      current = block;
      text = '';
    } else if (char === '}') {
      current.declarations += text;
      current = current.parent ?? root;
      text = '';
    } else {
      text += char;
    }
  }
  return blocks;
}

function inheritedColor(block: Block | undefined): string {
  for (let b = block; b !== undefined; b = b.parent) {
    const color = colorOf(b.declarations);
    if (color !== undefined) return color;
  }
  return PAGE_TEXT;
}

export function textPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const block of parse(source)) {
    const { declarations } = block;
    if (/content:\s*""/.test(declarations)) continue;
    const fg = colorOf(declarations);
    const bg = backgroundOf(declarations);
    if (fg !== undefined) {
      for (const surface of bg === undefined ? CARD_SURFACES : [bg]) pairs.push([fg, surface]);
    } else if (bg !== undefined) {
      pairs.push([inheritedColor(block.parent), bg]);
    }
  }
  return pairs;
}
