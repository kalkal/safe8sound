import { setLocale } from '@cold-reserve/i18n';
import type { ErrorCode, HomeStatus, InboxMessage } from '@cold-reserve/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { failedTurnText, mayHaveGoneThrough, readPhoneAgain, whatChangedAfter } from '../../src/ui/failed-turn.js';

afterEach(() => {
  setLocale('en-US');
});

// #477 (dev site, 20 Oct): a turn ended in HTTP 503 after its tools ran; the screen said "That took too long" while the
// storm was prepared and Ana was told. After a failed turn the page reads the home and the phone again (no model call)
// and says honestly what it finds: a new message to Ana, else a change in the home, else today's words.

const message = (at: string, transition = 'storm_expected'): InboxMessage =>
  ({ at, role: 'daughter', channel: 'push', transition, text: 'Storm expected: the home is ready.' }) as unknown as InboxMessage;
const home = (over: Record<string, unknown> = {}): HomeStatus =>
  ({
    homeId: 'h1',
    ts: '2026-07-15T12:00:00-05:00',
    batterySocPct: 78,
    pvW: 3200,
    loadW: 900,
    gridW: -1100,
    gridAvailable: true,
    level: 'comfort',
    levelReason: 'weather',
    levelChangedAt: '2026-07-15T08:00:00-05:00',
    controlAvailability: 'available',
    rooms: [{ roomId: 'r1', tempC: 26.4, occupants: ['older-man'], state: 'served' }],
    origin: 'simulated',
    homeLink: 'ok',
    ...over,
  }) as unknown as HomeStatus;

describe('what changed while a turn failed', () => {
  it('a new message to Ana says the action may have gone through, at its home time', () => {
    const before = [message('2026-07-15T08:00:00-05:00', 'storm_start')];
    const after = [message('2026-07-15T12:00:00-05:00'), ...before];
    expect(whatChangedAfter({ phoneBefore: before, phoneAfter: after, homeBefore: home(), homeAfter: home() })).toEqual({ kind: 'told', at: '2026-07-15T12:00:00-05:00' });
  });

  it('without a new message, a change in the home says so (the level or a room served or waiting)', () => {
    const level = home({ level: 'essential', levelChangedAt: '2026-07-15T12:00:00-05:00' });
    expect(whatChangedAfter({ phoneBefore: [], phoneAfter: [], homeBefore: home(), homeAfter: level })).toEqual({ kind: 'home' });
    const room = home({ rooms: [{ roomId: 'r1', tempC: 26.4, occupants: ['older-man'], state: 'waiting', waitingReason: 'level' }] });
    expect(whatChangedAfter({ phoneBefore: [], phoneAfter: [], homeBefore: home(), homeAfter: room })).toEqual({ kind: 'home' });
  });

  it('a temperature that moved, or a new measurement time, is not a change made by the turn', () => {
    const warmer = home({ ts: '2026-07-15T12:01:00-05:00', rooms: [{ roomId: 'r1', tempC: 26.9, occupants: ['older-man'], state: 'served' }] });
    expect(whatChangedAfter({ phoneBefore: [], phoneAfter: [], homeBefore: home(), homeAfter: warmer })).toEqual({ kind: 'nothing' });
  });

  // The phone's feed is a cached list that polls every few seconds (review of #491): a message timed before the turn started
  // is not news of this turn, even if the page sees it only now.
  it('a message to Ana from before the turn started is not news of this turn', () => {
    const older = message('2026-07-15T11:30:00-05:00');
    expect(whatChangedAfter({ phoneBefore: [], phoneAfter: [older], homeBefore: undefined, homeAfter: undefined, since: '2026-07-15T12:00:00-05:00' })).toEqual({ kind: 'nothing' });
    const newer = message('2026-07-15T12:00:00-05:00');
    expect(whatChangedAfter({ phoneBefore: [], phoneAfter: [older, newer], homeBefore: undefined, homeAfter: undefined, since: '2026-07-15T12:00:00-05:00' })).toEqual({ kind: 'told', at: '2026-07-15T12:00:00-05:00' });
  });

  it('only a timeout or a busy service may have let the tools run: the page reads again for those, never for a refusal or a wait', () => {
    expect(['agent_timeout', 'agent_unavailable'].every((code) => mayHaveGoneThrough(code as ErrorCode))).toBe(true);
    expect(['demo_quota_exceeded', 'turn_in_progress', 'invalid_input', 'bedrock_throttled'].some((code) => mayHaveGoneThrough(code as ErrorCode))).toBe(false);
  });

  it('nothing read (the reads failed too) is nothing to claim', () => {
    expect(whatChangedAfter({ phoneBefore: [], phoneAfter: [], homeBefore: undefined, homeAfter: undefined })).toEqual({ kind: 'nothing' });
  });
});

describe('what the screen says after a failed turn', () => {
  it('names the time Ana was told, in 24 h, in English and Italian', () => {
    expect(failedTurnText({ kind: 'told', at: '2026-07-15T12:00:00-05:00' }, 'agent_timeout')).toBe('That took too long, but it may have gone through: Ana was told at 12:00.');
    setLocale('it-IT');
    expect(failedTurnText({ kind: 'told', at: '2026-07-15T09:05:00+02:00' }, 'agent_timeout')).toBe('Ci ho messo troppo, ma potrebbe essere andata a buon fine: Ana è stata avvisata alle 09:05.');
  });

  it('a home change without a message points to the card, without naming an action', () => {
    expect(failedTurnText({ kind: 'home' }, 'agent_timeout')).toBe('That took too long, but it may have gone through: the home has changed — see the card.');
    // The words start from what happened (review of #491): a service that failed did not "take too long".
    expect(failedTurnText({ kind: 'home' }, 'agent_unavailable')).toBe("I couldn't finish the answer, but it may have gone through: the home has changed — see the card.");
    expect(failedTurnText({ kind: 'told', at: '2026-07-15T12:00:00-05:00' }, 'agent_unavailable')).toBe("I couldn't finish the answer, but it may have gone through: Ana was told at 12:00.");
  });

  it('nothing changed: the words of today', () => {
    expect(failedTurnText({ kind: 'nothing' }, 'agent_timeout')).toBe('That took too long. Please try again.');
    expect(failedTurnText({ kind: 'nothing' }, 'agent_unavailable')).toBe("I can't answer right now. Try again in a moment.");
  });
});

describe('reading the phone again after a failed turn', () => {
  const feed = (refresh?: () => void) => {
    let messages: readonly InboxMessage[] = [];
    const listeners = new Set<() => void>();
    return {
      set: (m: readonly InboxMessage[]) => {
        messages = m;
        for (const l of listeners) l();
      },
      feed: {
        messages: () => messages,
        subscribe: (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        ...(refresh === undefined ? {} : { refresh }),
      },
    };
  };

  it('resolves with the new messages as soon as the phone has them', async () => {
    const f = feed(() => {
      f.set([message('2026-07-15T12:00:00-05:00')]);
    });
    expect(await readPhoneAgain(f.feed, 60_000)).toHaveLength(1);
  });

  it('resolves with what it has after a short wait when nothing changes, and a phone with no reads at once', async () => {
    const quiet = feed(() => undefined);
    expect(await readPhoneAgain(quiet.feed, 10)).toEqual([]);
    expect(await readPhoneAgain(feed().feed, 60_000)).toEqual([]);
  });
});
