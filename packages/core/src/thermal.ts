import { celsius, watt, type Celsius, type Minutes, type Watt } from '@cold-reserve/contracts';

// 1R1C thermal model per room (plan §3.1, spike S6):
//   C dT/dt = (Tout - T) / R + Q
// R in K/kW, C in kWh/K, Q = net heat into the room in kW (gains minus HVAC cooling).
// We use the exact solution over a step, so any step length is stable:
//   T(t + dt) = Teq + (T - Teq) e^(-dt / RC),   Teq = Tout + R Q.

export interface ThermalParams {
  readonly rKPerKw: number;
  readonly cKwhPerK: number;
}

const decay = (dt: Minutes, thermal: ThermalParams): number => Math.exp(-(dt / 60) / (thermal.rKPerKw * thermal.cKwhPerK));

const equilibriumC = (outC: Celsius, netHeatW: number, thermal: ThermalParams): number => outC + (thermal.rKPerKw * netHeatW) / 1000;

export function stepRoomTemperature(input: { tempC: Celsius; outC: Celsius; netHeatW: Watt; dt: Minutes; thermal: ThermalParams }): Celsius {
  const teq = equilibriumC(input.outC, input.netHeatW, input.thermal);
  return celsius(teq + (input.tempC - teq) * decay(input.dt, input.thermal));
}

/**
 * HVAC cooling (W, heat removed; negative = heating) that makes the room land exactly on `targetC`
 * after one step, given the other heat gains. The HVAC model then caps it to what the units can do.
 */
export function coolingToReachW(input: { tempC: Celsius; outC: Celsius; targetC: Celsius; gainsW: Watt; dt: Minutes; thermal: ThermalParams }): Watt {
  const k = decay(input.dt, input.thermal);
  // Solve target = Teq + (T - Teq) k for Teq, then Teq = Tout + R (gains - cooling) for cooling.
  const teqNeeded = (input.targetC - input.tempC * k) / (1 - k);
  return watt(input.gainsW - ((teqNeeded - input.outC) * 1000) / input.thermal.rKPerKw);
}
