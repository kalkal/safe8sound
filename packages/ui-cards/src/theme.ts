export type CardTheme = 'pawnio-dark' | 'pawnio-light';

/** hostContext.theme picks light or dark; the Amazon card guide default is dark (spike S3). */
export function cardThemeFor(hostTheme: 'light' | 'dark' | undefined): CardTheme {
  return hostTheme === 'light' ? 'pawnio-light' : 'pawnio-dark';
}
