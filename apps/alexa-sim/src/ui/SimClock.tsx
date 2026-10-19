import type { MilestoneKind } from '@cold-reserve/contracts';
import { useId } from 'react';
import { clockTime, type ClockState } from './sim-clock.js';
import { Spinner } from './Spinner.js';
import { t } from './text.js';

// The simulated clock (owner decision, 10 Oct; made big under the Echo frame in #391, the top bar pill went unseen): it
// says the simulated time (marked SIMULATED, never the real hour), one big button that skips to the next moment and
// says where it goes, and a line on what just happened or why it cannot. The button's verb can be said too.

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

/** `summary`: what the last jump changed, where the judges' panel that says it is a closed sheet (owner, 19 Oct, J = a). */
export function SimClock({ state, note, busy, onSkip, summary }: { state: ClockState; note?: ClockNote; busy: boolean; onSkip: () => void; summary?: string | undefined }) {
  const noteId = useId();
  // The button says where it goes ("Go to 22:00 · the home steps down to its essential settings"); with nothing ahead it keeps
  // its plain name, disabled, and the line beside it says why.
  const target = state.next === undefined ? undefined : t('clock.skipTo', { time: clockTime(state.next.at), moment: momentText(state.next.kind) });
  return (
    <div className="sim-dock" role="group" aria-label={t('clock.label')} data-testid="sim-clock">
      <span className="sim-dock-time">
        <span className="sim-dock-badge">{t('clock.badge')}</span>
        <time dateTime={state.now}>{clockTime(state.now)}</time>
      </span>
      <button type="button" className="chip-button sim-dock-skip" aria-describedby={noteId} aria-busy={busy} disabled={busy || state.next === undefined} onClick={onSkip}>
        <span className="sim-dock-words">{target ?? t('clock.skip')}</span>
        {busy ? <Spinner /> : <span aria-hidden="true"> ››</span>}
      </button>
      <span className="sim-dock-lines">
        <span id={noteId} className="sim-dock-note" role="status">
          {noteText(state, note, busy)}
        </span>
        {summary !== undefined && (
          <span className="sim-dock-summary" data-testid="clock-jump-summary">
            {summary}
          </span>
        )}
      </span>
    </div>
  );
}
