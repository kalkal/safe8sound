import { useEffect, useRef, type RefObject } from 'react';
import type { HistoryPosition } from './answer-history.js';
import { t } from './text.js';

// One answer at a time (owner's choice, 10 Oct): Previous / Next and where we are. The labels are what a person
// would say. With one answer only there is nothing to page, so nothing is drawn. In the header band the buttons show
// the short word, inside their full spoken name (label in name).

export function AnswerPager({ position, onStep }: { position: HistoryPosition; onStep: (delta: -1 | 1) => void }) {
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  useKeepFocus(previous, next, position.hasPrevious, position.hasNext);
  if (position.of < 2) return null;
  return (
    <nav className="answer-pager" aria-label={t('answers.nav')}>
      <button
        type="button"
        className="chip-button"
        ref={previous}
        disabled={!position.hasPrevious}
        aria-label={t('answers.previous')}
        onClick={() => {
          onStep(-1);
        }}
      >
        {t('answers.previousShort')}
      </button>
      <span className="answer-pager-where">{t('answers.position', { n: String(position.n), of: String(position.of) })}</span>
      <button
        type="button"
        className="chip-button"
        ref={next}
        disabled={!position.hasNext}
        aria-label={t('answers.next')}
        onClick={() => {
          onStep(1);
        }}
      >
        {t('answers.nextShort')}
      </button>
    </nav>
  );
}

/**
 * A keyboard user who pressed Previous or Next up to an end is not left on a button that just became unavailable (focus
 * would fall back to the page): the focus moves to the other one.
 */
function useKeepFocus(previous: RefObject<HTMLButtonElement | null>, next: RefObject<HTMLButtonElement | null>, hasPrevious: boolean, hasNext: boolean): void {
  const last = useRef<'previous' | 'next' | null>(null);
  useEffect(() => {
    const p = previous.current;
    const n = next.current;
    const onPrevious = () => {
      last.current = 'previous';
    };
    const onNext = () => {
      last.current = 'next';
    };
    p?.addEventListener('focus', onPrevious);
    n?.addEventListener('focus', onNext);
    return () => {
      p?.removeEventListener('focus', onPrevious);
      n?.removeEventListener('focus', onNext);
    };
  });
  useEffect(() => {
    const active = document.activeElement;
    const lost = (button: HTMLButtonElement | null) => active === button || active === document.body || active === null;
    if (!hasNext && last.current === 'next' && lost(next.current)) previous.current?.focus();
    if (!hasPrevious && last.current === 'previous' && lost(previous.current)) next.current?.focus();
  }, [hasPrevious, hasNext, previous, next]);
}
