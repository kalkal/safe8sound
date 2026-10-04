import { t } from './text.js';

// Demo mode for recording the video (`?demo=1`): the last question as a caption, as the video shows a spoken
// line, and the light bar an Echo Show lights while Alexa speaks. Both repeat what the page already says, so
// screen readers skip the bar and the caption is plain text, never a live region.

export interface DemoOverlayProps {
  /** The last question, typed or spoken; null before the first one. */
  said: string | null;
  speaking: boolean;
}

export function DemoOverlay({ said, speaking }: DemoOverlayProps) {
  return (
    <>
      {said !== null && (
        <p className="demo-caption" data-testid="demo-caption">
          {t('demoMode.youSaid', { said })}
        </p>
      )}
      <div className="demo-light-bar" data-testid="demo-light-bar" data-lit={speaking} aria-hidden="true" />
    </>
  );
}
