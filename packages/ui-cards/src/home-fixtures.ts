import { HomeStatusSchema, type HomeStatus } from '@cold-reserve/contracts';

// get_home_status during the storm-blackout scene: grid down, the battery feeds the safe room only;
// the other rooms wait for the level. Parsed by the contract schema.

export function homeInStorm(): HomeStatus {
  return HomeStatusSchema.parse({
    homeId: 'demo',
    ts: '2026-07-18T21:24:00+02:00',
    batterySocPct: 48,
    pvW: 0,
    loadW: 500,
    gridW: 0,
    gridAvailable: false,
    level: 'essential',
    levelReason: 'storm',
    levelChangedAt: '2026-07-18T21:10:00+02:00',
    controlAvailability: 'ok',
    rooms: [
      { roomId: 'bedroom-1', tempC: 26.8, humidityPct: 55, occupants: ['grandpa'], state: 'served' },
      { roomId: 'bedroom-2', tempC: 28.1, occupants: [], state: 'waiting', waitingReason: 'pacing_level' },
      { roomId: 'living', tempC: 28.4, occupants: [], state: 'waiting', waitingReason: 'pacing_level' },
      { roomId: 'study', tempC: 28.9, occupants: [], state: 'waiting', waitingReason: 'pacing_level' },
    ],
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'storm-blackout' },
    homeLink: 'ok',
  });
}
