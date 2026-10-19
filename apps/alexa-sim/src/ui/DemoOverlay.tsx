import { t } from './text.js';

// Demo mode for recording the video (`?demo=1`): the last question as a caption, as the video shows a spoken line. A
// real Echo Show never writes what the person said (#432 S6): this is a help for the video only, said so in its words.
// It repeats what the page already says, so it is plain text, never a live region. The light at the bottom of the
// screen is the VoiceBar, always there.

export interface DemoOverlayProps {
  /** The last question, typed or spoken; null before the first one. */
  said: string | null;
}

export function DemoOverlay({ said }: DemoOverlayProps) {
  if (said === null) return null;
  return (
    <p className="demo-caption" data-testid="demo-caption">
      {t('demoMode.youSaid', { said })}
    </p>
  );
}
