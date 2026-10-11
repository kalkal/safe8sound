// One answer at a time (owner's choice, 10 Oct): the turns that answered, newest last, and the one on screen.
// Pure, so the paging rules are tested without a page. The answers themselves stay in the query cache.

/** How many answers Previous can go back through: the page never grows without end. */
export const ANSWER_HISTORY_MAX = 10;

export interface AnswerHistory {
  readonly turns: readonly string[];
  /** The answer on screen, an index into `turns`. */
  readonly index: number;
}

export interface HistoryPosition {
  /** 1-based, as said: "Answer 2 of 3". */
  readonly n: number;
  readonly of: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export const emptyHistory: AnswerHistory = { turns: [], index: -1 };

/** A new answer goes at the end and is shown at once; a turn already kept is shown again, not added twice. */
export function addAnswer(history: AnswerHistory, turnId: string): AnswerHistory {
  const known = history.turns.indexOf(turnId);
  if (known >= 0) return { turns: history.turns, index: known };
  const turns = [...history.turns, turnId].slice(-ANSWER_HISTORY_MAX);
  return { turns, index: turns.length - 1 };
}

/** Previous (-1) or Next (+1); both ends stop. */
export function stepAnswer(history: AnswerHistory, delta: -1 | 1): AnswerHistory {
  if (history.turns.length === 0) return history;
  const index = Math.min(history.turns.length - 1, Math.max(0, history.index + delta));
  return { turns: history.turns, index };
}

export const currentAnswer = (history: AnswerHistory): string | undefined => history.turns[history.index];

export function historyPosition(history: AnswerHistory): HistoryPosition | undefined {
  if (history.turns.length === 0) return undefined;
  const of = history.turns.length;
  return { n: history.index + 1, of, hasPrevious: history.index > 0, hasNext: history.index < of - 1 };
}
