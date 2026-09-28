export type TurnMark = 'submitted' | 'speechEnd' | 'recognised' | 'replyReady' | 'audioStart' | 'audioEnd';

export interface TurnSummary {
  /** Chrome's `speechend` → final result. */
  recognitionMs: number | null;
  /** Input known → reply text ready (the agent). */
  replyMs: number | null;
  /** Reply ready → first audio (`utterance.onstart`). */
  ttsStartMs: number | null;
  /** What the person feels: end of their input → first audio. */
  perceivedMs: number | null;
  speakingMs: number | null;
}

const between = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? null : Math.round(b - a));

export function createTurnTimer(now: () => number = () => performance.now()) {
  let marks = new Map<TurnMark, number>();
  return {
    mark(name: TurnMark) {
      if (!marks.has(name)) marks.set(name, now());
    },
    reset() {
      marks = new Map();
    },
    summary(): TurnSummary {
      const m = (k: TurnMark) => marks.get(k);
      const inputKnown = m('recognised') ?? m('submitted');
      const turnStart = m('speechEnd') ?? inputKnown;
      return {
        recognitionMs: between(m('speechEnd'), m('recognised')),
        replyMs: between(inputKnown, m('replyReady')),
        ttsStartMs: between(m('replyReady'), m('audioStart')),
        perceivedMs: between(turnStart, m('audioStart')),
        speakingMs: between(m('audioStart'), m('audioEnd')),
      };
    },
  };
}

/** Nearest-rank percentile. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}
