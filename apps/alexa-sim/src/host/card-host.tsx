import type { LocationId, Result, TempUnit } from '@cold-reserve/contracts';
import type { CardKind } from '@cold-reserve/ui-cards';
import { createContext, useContext, type ReactNode } from 'react';
import type { Agent } from '../agent/agent.js';
import type { ToolCard } from '../agent/wire.js';
import type { CardActions, FrameEvent } from './card-actions.js';

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
  /** The temperature unit the person chose (demo settings); °C when absent. */
  units?: TempUnit;
  /** #376: the place the person chose (demo settings), for the number to call on a last resort; unknown when absent. */
  place?: LocationId | undefined;
  /** A card action that succeeded (its tool name, the turn of its card and its structured result): the page may update what it shows, e.g. the home panel, the steps. */
  onCardAction?: (name: string, turnId: string, result: unknown) => void;
  /** Where each card's action stands (card-actions), kept above the frames: a card shown again gets it back. */
  actions?: CardActions;
  /** A call of a turn's card started or got its answer. */
  onCardCall?: (turnId: string, card: ToolCard, event: FrameEvent) => void;
  /** The clock the plans are made on (the sandbox's simulated clock), when the page knows it: plans expire on it. */
  planNow?: string | undefined;
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
