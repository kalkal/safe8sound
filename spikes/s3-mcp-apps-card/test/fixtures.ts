import type { Plan } from '../src/card/plan.js';

// Sample content only (plan §11.1: mockup texts are examples).
export const hotDayPlan: Plan = {
  planId: 'plan-0001',
  expiresAt: '2026-09-26T12:10:00Z',
  goal: 'cool',
  until: '06:40',
  confidence: 'high',
  confidenceReason: 'clear sky, forecast agrees with the last 3 days',
  level: 'comfort',
  levelReason: 'weather',
  reserveHours: 7.5,
  guarantees: [
    { id: 'storm_reserve', ok: true, label: 'Storm reserve', value: '6 kWh kept' },
    { id: 'pacing_on_track', ok: true, label: 'Pacing on track', value: 'energy lasts until 06:40' },
    { id: 'safe_room_comfort', ok: true, label: 'Safe room comfort', value: '≤ 27 °C, ≤ 60% RH' },
  ],
  dataOrigin: 'simulated',
  storm: false,
  applyAllowed: true,
};

export const stormPlan: Plan = {
  ...hotDayPlan,
  planId: 'plan-0002',
  level: 'essential',
  levelReason: 'storm',
  confidence: 'medium',
  confidenceReason: 'grid return time unknown',
  reserveHours: 10.75,
  storm: true,
  stormSince: '19:40',
  applyAllowed: false,
  applyBlockedReason: 'The guard keeps the storm reserve: nothing to apply while the grid is down.',
};
