import type { DataOriginValue } from '@cold-reserve/contracts';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { t } from './text.js';

/** LIVE / SIMULATED next to every number (plan §11.1): simulated data is never shown as real. */
export function OriginBadge({ origin }: { origin: DataOriginValue }) {
  return (
    <span className="origin-badge" data-origin={origin} data-testid="origin-badge">
      {origin === 'simulated' && <span aria-hidden="true">≈ </span>}
      {t(origin === 'live' ? 'data.live' : 'data.simulatedBadge')}
    </span>
  );
}

/**
 * Every card: a titled section with its data badge. Inline by default; full screen only when the person asks,
 * for the whole frame through the host (plan §11.2 p.2, #200), never a button that only flips its label.
 * Pages instead of scrolling (owner, 10 Oct): with `pages`, one page at a time (the first carries the card's one giant
 * number), "Previous page / 1 of 3 / Next page" in the title row; the other pages stay in the card, hidden. `children`
 * come after the pages, always shown.
 */
/**
 * The frame's "Full screen" / "Back to the conversation", given by the card app: the first card of the frame shows it in
 * its title row (pages instead of scrolling, owner 10 Oct: one row less), the cards inside it never repeat it.
 */
export const DisplaySlot = createContext<ReactNode>(null);

export function CardShell({ title, origin, pages, children }: { title: string; origin?: DataOriginValue; pages?: readonly ReactNode[]; children?: ReactNode }) {
  const titleId = useId();
  const [page, setPage] = useState(0);
  const count = pages?.length ?? 0;
  const display = useContext(DisplaySlot);
  return (
    <section className="card" aria-labelledby={titleId}>
      <header className="card-head">
        <h2 id={titleId}>{title}</h2>
        {origin !== undefined && <OriginBadge origin={origin} />}
        {count > 1 && <PageNav page={page} count={count} onPage={setPage} />}
        {display}
      </header>
      <DisplaySlot.Provider value={null}>
        {pages?.map((content, i) => (
          <div key={i} className="card-page" data-page={i + 1} hidden={i !== page}>
            {content}
          </div>
        ))}
        {children}
      </DisplaySlot.Provider>
    </section>
  );
}

/** The labels are what a person would say; the buttons show the short word, inside their spoken name. */
function PageNav({ page, count, onPage }: { page: number; count: number; onPage: (page: number) => void }) {
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  useKeepFocus(previous, next, page > 0, page < count - 1);
  return (
    <nav className="page-nav" aria-label={t('card.pages')}>
      <button
        type="button"
        className="button-secondary"
        ref={previous}
        aria-label={t('card.previousPage')}
        disabled={page === 0}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        {t('card.previousShort')}
      </button>
      <span className="page-where">{t('card.pagePosition', { n: String(page + 1), of: String(count) })}</span>
      <button
        type="button"
        className="button-secondary"
        ref={next}
        aria-label={t('card.nextPage')}
        disabled={page === count - 1}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        {t('card.nextShort')}
      </button>
    </nav>
  );
}

/** The frame's display mode as the host offers it (MCP Apps availableDisplayModes / displayMode). */
export interface DisplayControl {
  readonly canFullscreen: boolean;
  readonly fullscreen: boolean;
  /** Asks the host for the other mode; the host answers with the mode it really set. */
  readonly toggle: () => void;
}

/** One "Full screen" / "Back" for the whole frame; Escape goes back. None when the host cannot show it. */
export function DisplayToggle({ display }: { display: DisplayControl }) {
  const { fullscreen, toggle } = display;
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [fullscreen, toggle]);
  if (!display.canFullscreen) return null;
  return (
    <div className="display-toggle">
      <button type="button" className="card-expand" onClick={toggle}>
        {t(fullscreen ? 'card.back' : 'card.fullScreen')}
      </button>
    </div>
  );
}

/**
 * A keyboard user who pressed Previous or Next up to the first or last page is not left on a button that just became
 * unavailable (focus would fall back to the page): the focus moves to the other one.
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
