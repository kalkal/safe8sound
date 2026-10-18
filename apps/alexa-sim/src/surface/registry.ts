import { EchoShowLayout } from '../layouts/alexa-echo-show/EchoShowLayout.js';
import { PlainLayout } from '../layouts/plain/PlainLayout.js';
import type { LayoutId, SurfaceLayout } from './contract.js';

/** The one place a layout id becomes a layout (#432). A new layout is a new folder plus one line here. */
export const LAYOUTS: Readonly<Record<LayoutId, SurfaceLayout>> = {
  'alexa-echo-show': EchoShowLayout,
  plain: PlainLayout,
};
