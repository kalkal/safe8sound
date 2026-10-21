import type { ErrorCode, HomeStatus, InboxMessage } from '@cold-reserve/contracts';
import type { PhoneFeed } from '../phone/phone-feed.js';
import { clockTime } from './sim-clock.js';
import { t } from './text.js';

// #477 (dev site, 20 Oct): a turn ended in HTTP 503 after its tools ran, and the screen said "That took too long" while
// the storm was prepared and Ana was told. After such a turn the page reads the home and the phone again (reads only,
// never the model) and says honestly what it finds. Robust over specific (owner's choice, 20 Oct): the time Ana was
// told, else that the home changed, never the name of an action the page cannot be sure of.

export type FailedTurnFinding = { readonly kind: 'told'; readonly at: string } | { readonly kind: 'home' } | { readonly kind: 'nothing' };

/**
 * Whether a failed turn may have let its tools run (review of #491): a timeout or a busy service, after the model may
 * have called them. A refusal or a wait (the quota, a turn already running) ran nothing: the page does not read again.
 */
export const mayHaveGoneThrough = (code: ErrorCode): boolean => code === 'agent_timeout' || code === 'agent_unavailable';

const keyOf = (m: InboxMessage) => `${m.at}|${m.transition}|${m.role}`;

/** What a turn may change in the home: its level and which rooms are served; never a temperature or a measurement time. */
const changeable = (home: HomeStatus) => JSON.stringify([home.level, home.levelChangedAt, home.rooms.map((r) => [r.roomId, r.state, r.waitingReason ?? null])]);

/**
 * What changed between the reads before the failed turn and after it: a new message to Ana wins, then the home. A message
 * timed before the turn started (`since`, the home's time then) is not news of this turn: the phone's feed is a cached
 * list that polls every few seconds, so the page may see an older message only now (review of #491).
 */
export function whatChangedAfter(o: {
  phoneBefore: readonly InboxMessage[];
  phoneAfter: readonly InboxMessage[];
  homeBefore: HomeStatus | undefined;
  homeAfter: HomeStatus | undefined;
  since?: string | undefined;
}): FailedTurnFinding {
  const seen = new Set(o.phoneBefore.map(keyOf));
  const since = o.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(o.since);
  const fresh = o.phoneAfter.filter((m) => !seen.has(keyOf(m)) && Date.parse(m.at) >= since);
  const newest = fresh.reduce<InboxMessage | undefined>((a, m) => (a === undefined || Date.parse(m.at) > Date.parse(a.at) ? m : a), undefined);
  if (newest !== undefined) return { kind: 'told', at: newest.at };
  if (o.homeBefore !== undefined && o.homeAfter !== undefined && changeable(o.homeBefore) !== changeable(o.homeAfter)) return { kind: 'home' };
  return { kind: 'nothing' };
}

/**
 * The words of the failure box: they start from what happened (a timeout took too long; a busy service could not finish),
 * then what may have gone through, with Ana's time in 24 h; with nothing new, the words of today.
 */
export function failedTurnText(finding: FailedTurnFinding, code: ErrorCode): string {
  const prefix = t(code === 'agent_timeout' ? 'chat.failedPrefixTimeout' : 'chat.failedPrefixUnavailable');
  if (finding.kind === 'told') return t('chat.mayHaveGoneThroughTold', { prefix, time: clockTime(finding.at) });
  if (finding.kind === 'home') return t('chat.mayHaveGoneThroughHome', { prefix });
  return t(code === 'agent_timeout' ? 'chat.errorTimeout' : 'chat.errorTransient');
}

/** How long the phone's own read may take after a failed turn before the page says what it has (the poll is 5 s). */
const PHONE_READ_WAIT_MS = 3000;

/** Reads the phone again now and resolves with its messages once they change, or after a short wait (never an error). */
export function readPhoneAgain(feed: PhoneFeed, waitMs: number = PHONE_READ_WAIT_MS): Promise<readonly InboxMessage[]> {
  if (feed.refresh === undefined) return Promise.resolve(feed.messages());
  const refresh = feed.refresh;
  return new Promise((resolve) => {
    let off: () => void = () => undefined;
    const done = () => {
      clearTimeout(timer);
      off();
      resolve(feed.messages());
    };
    const timer = setTimeout(done, waitMs);
    off = feed.subscribe(done);
    refresh();
  });
}
