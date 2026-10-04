import type { Plan } from '@cold-reserve/contracts';
import { homeClock } from '@cold-reserve/ui-cards';
import type { CardSlot, ToolCard } from '../agent/wire.js';

// The sky of the Echo Show frame follows the scenario weather (plan §11.1, design analysis G2): it is read
// from the cards of each answer, never guessed. Storm clouds while the grid is down; the heat haze of a
// heatwave scenario, or its warm dusk after 19:00 on the home's clock; the sun otherwise. An answer that says
// nothing about the weather keeps the sky it had. The cards keep the Amazon style: the sky is only the frame.

export const SKIES = ['mild', 'hot', 'dusk', 'storm'] as const;
export type Sky = (typeof SKIES)[number];

const EVENING_FROM_H = 19;
const MORNING_AT_H = 6;
const HEATWAVE = /heat/;

type Signal = 'storm' | 'calm' | { heatAt: string } | undefined;

function planSignal(plan: Plan): Signal {
  if (plan.gridAvailable === false) return 'storm';
  return HEATWAVE.test(plan.sourceOrigin.scenario ?? '') ? { heatAt: plan.createdAt } : undefined;
}

function signalOf(card: CardSlot): Signal {
  if (card.tool === 'invalid') return undefined;
  return toolSignal(card);
}

function toolSignal(card: ToolCard): Signal {
  switch (card.tool) {
    case 'plan_comfort':
      // A refusal (an error envelope) says nothing about the weather.
      return 'id' in card.result ? planSignal(card.result) : undefined;
    case 'apply_plan':
      return planSignal(card.result.plan);
    case 'get_safe_room_status':
      if (card.result.stormPhase === 'active') return 'storm';
      return card.result.stormPhase === 'ended' ? 'calm' : undefined;
    case 'get_home_status':
      return card.result.gridAvailable ? undefined : 'storm';
    default:
      return undefined;
  }
}

export function skyFor(cards: readonly CardSlot[], timeZone: string, previous: Sky): Sky {
  const signals = cards.map(signalOf);
  if (signals.includes('storm')) return 'storm';
  if (signals.includes('calm')) return 'mild';
  const heat = signals.find((s): s is { heatAt: string } => typeof s === 'object');
  if (heat === undefined) return previous;
  // The home's clock, as every card shows it ("21:10").
  const hour = Number(homeClock(heat.heatAt, timeZone).slice(0, 2));
  return hour >= EVENING_FROM_H || hour < MORNING_AT_H ? 'dusk' : 'hot';
}
