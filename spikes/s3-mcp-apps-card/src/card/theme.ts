export type CardTheme = 'pawnio-dark' | 'pawnio-light';

/** hostContext.theme picks light or dark; the Amazon guide default for cards is dark. */
export function cardThemeFor(hostTheme: 'light' | 'dark' | undefined): CardTheme {
  return hostTheme === 'light' ? 'pawnio-light' : 'pawnio-dark';
}

export function applyCardTheme(root: HTMLElement, hostTheme: 'light' | 'dark' | undefined, storm: boolean): void {
  root.dataset['cardTheme'] = cardThemeFor(hostTheme);
  root.classList.toggle('theme-storm', storm);
}
