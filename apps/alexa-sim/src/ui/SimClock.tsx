import type { MilestoneKind } from '@cold-reserve/contracts';
import { useId } from 'react';
import { clockTime, type ClockState } from './sim-clock.js';
import { t } from './text.js';

// The simulated clock (owner decision, 10 Oct): above the device, beside the scenario badge, for every visitor. It
// says the simulated time (marked SIMULATED, never the real hour), what just happened or what comes next, and one
// quiet button that skips to the next moment: never the screen's bright action. Its label can be said too.

/** What the clock says under the time: the last thing that happened, or the next moment. */
export type ClockNote = { readonly kind: 'grid_down' } | { readonly kind: 'reached'; readonly moment: MilestoneKind } | { readonly kind: 'failed' } | { readonly kind: 'limit' };

const momentText = (kind: MilestoneKind) => t(`clock.kind.${kind}`);

function noteText(state: ClockState, note: ClockNote | undefined, busy: boolean): string {
  if (busy) return t('clock.moving');
  if (note?.kind === 'grid_down') return t('clock.gridDown');
  if (note?.kind === 'failed') return t('clock.failed');
  if (note?.kind === 'limit') return t('clock.limit');
  if (note?.kind === 'reached') return t('clock.reached', { moment: momentText(note.moment) });
  return state.next === undefined ? t('clock.nothingNext') : t('clock.next', { moment: momentText(state.next.kind), time: clockTime(state.next.at) });
}

export function SimClock({ state, note, busy, onSkip }: { state: ClockState; note?: ClockNote; busy: boolean; onSkip: () => void }) {
  const noteId = useId();
  return (
    <div className="sim-clock" role="group" aria-label={t('clock.label')} data-testid="sim-clock">
      <span className="sim-clock-time">
        <span className="sim-clock-badge">
          {/* A phone shows the short mark: the time never looks like the real hour (review of #378). */}
          <span className="sim-clock-long">{t('clock.badge')}</span>
          <span className="sim-clock-short" aria-hidden="true">
            {t('clock.badgeShort')}
          </span>
        </span> <time dateTime={state.now}>{clockTime(state.now)}</time>
      </span>
      <span id={noteId} className="sim-clock-note" role="status">
        {noteText(state, note, busy)}
      </span>
      <button type="button" className="chip-button sim-clock-skip" aria-describedby={noteId} disabled={busy || state.next === undefined} onClick={onSkip}>
        <span className="sim-clock-words">{t('clock.skip')}</span>
        <span aria-hidden="true"> ››</span>
      </button>
    </div>
  );
}
