import type { Result } from '@cold-reserve/contracts';
import type { CardKind } from '@cold-reserve/ui-cards';
import { createContext, useContext, type ReactNode } from 'react';
import type { Agent } from '../agent/agent.js';

/** What every card frame needs from the page: the agent for card actions, the documents, and the host context. */
export interface CardHost {
  agent: Agent;
  /** The self-contained ui:// document of a card, with the host CSP; refused without a <head>. */
  documentFor: (kind: CardKind) => Result<string, 'no_head'>;
  theme: 'dark' | 'light';
  /** IANA zone of the home: every card shows the home's clock. */
  timeZone: string;
  /** Demo mode for the video (`?demo=1`): the cards mark each tap inside their frame. */
  demo?: boolean;
}

const CardHostContext = createContext<CardHost | null>(null);

export function CardHostProvider({ value, children }: { value: CardHost; children: ReactNode }) {
  return <CardHostContext.Provider value={value}>{children}</CardHostContext.Provider>;
}

export function useCardHost(): CardHost {
  const host = useContext(CardHostContext);
  if (host === null) throw new Error('Card frames need a CardHostProvider');
  return host;
}
