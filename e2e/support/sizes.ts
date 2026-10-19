import data from './sizes.json' with { type: 'json' };

// The screen sizes every journey walks (outcome O10, one screen at every size), defined once in sizes.json: the site
// config makes one Playwright project per size (`journey-<id>`), tooling/src/outcomes.mjs runs one size at a time.

export interface Size {
  /** The project's suffix and the name a command takes (`pnpm journey:judge 1904x870`). */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Echo Show screens and the phone have no desktop browser around the page. */
  readonly device: 'desktop' | 'echo' | 'phone';
  /** What a judge or a person at home looks at with this window. */
  readonly what: string;
}

export const SIZES: readonly Size[] = data.sizes as readonly Size[];

/** The usable windows of common laptop screens (#432 S6): one screen at each, checked by the geometry spec only. */
export const LAPTOP_WINDOWS: readonly Size[] = data.laptopWindows as readonly Size[];

/** The journey project of a size. */
export const projectOf = (size: Size): string => `journey-${size.id}`;

/** The size a journey runs at, from its project's name. */
export function sizeOfProject(project: string): Size {
  const size = SIZES.find((s) => projectOf(s) === project);
  if (size === undefined) throw new Error(`"${project}" is not a journey project: run journeys with --project journey-<size> (e2e/support/sizes.json).`);
  return size;
}
