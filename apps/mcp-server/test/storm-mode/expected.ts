import type { Forecast, HomeProfile, Preferences, Snapshot } from '@cold-reserve/contracts';
import type { StormModeConfig } from '../../src/modules/storm-mode/config.js';

/**
 * The acceptance formula of #23 written out by hand, independently of core: (SOC - hardware floor) x
 * capacity x round-trip efficiency / (split power that holds the cooling threshold + EPS base load).
 */
export function expectedSafeHours(input: { snapshot: Snapshot; forecast: Forecast; profile: HomeProfile; preferences: Preferences; config: StormModeConfig }): number {
  const { snapshot, forecast, profile, preferences, config } = input;
  const b = profile.battery;
  const capacityWh = b.usableWh / ((100 - b.minSocHwPct) / 100);
  const energyWh = ((snapshot.batterySocPct - b.minSocHwPct) / 100) * capacityWh * b.roundTripEff;

  const room = profile.rooms.find((r) => r.id === preferences.safeRoomId);
  const unit = room?.hvacUnits[0];
  const reading = snapshot.rooms.find((r) => r.id === preferences.safeRoomId);
  const now = Date.parse(snapshot.ts);
  const hour = [...forecast.hourly].reverse().find((h) => Date.parse(h.ts) <= now) ?? forecast.hourly[0];
  if (!room || !unit || !reading || !hour) throw new Error('the scenario has no safe room or no weather');

  const gainW = (Math.max(0, hour.tempOutC - preferences.safety.cooling.maxC) * 1000) / room.thermal.rKPerKw + reading.occupants.length * config.occupantGainW;
  const cop = unit.coolingKw / unit.inputKw.nominal;
  const holdW = gainW <= 0 ? 0 : Math.min(Math.max(gainW / cop, unit.inputKw.min * 1000), unit.inputKw.max * 1000);
  return Math.min(energyWh / (holdW + config.epsBaseLoadW), config.capHours);
}
