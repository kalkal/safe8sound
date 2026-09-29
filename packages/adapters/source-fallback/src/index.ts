/** FallbackSource: the real home first, the simulator after 15 minutes of stale data, declared. */
export const packageName = '@cold-reserve/source-fallback';

export { FallbackSource, type FallbackSourceOptions, type SourceEvent } from './fallback-source.js';
