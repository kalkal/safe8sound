import type { InboxMessage } from '@cold-reserve/contracts';

// The family phone (surface C, #24) reads its messages from a feed: the scripted one below in tests,
// CI and the scripted demo; later a feed that polls GET /phone/inbox with the phone's own token.

export interface PhoneFeed {
  /** The messages on the phone, newest first; the same array until something changes. */
  readonly messages: () => readonly InboxMessage[];
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ScriptedPhone extends PhoneFeed {
  /** What the scripted scene sends to the family. A message already on the phone is not shown twice. */
  readonly deliver: (messages: readonly InboxMessage[]) => void;
}

const keyOf = (m: InboxMessage) => `${m.at}|${m.transition}|${m.role}`;

export function createScriptedPhone(): ScriptedPhone {
  let current: readonly InboxMessage[] = [];
  const listeners = new Set<() => void>();
  return {
    messages: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deliver: (messages) => {
      const seen = new Set(current.map(keyOf));
      const fresh = messages.filter((m) => !seen.has(keyOf(m)));
      if (fresh.length === 0) return;
      current = [...fresh, ...current].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      for (const listener of listeners) listener();
    },
  };
}
