import { TempUnitSchema, type TempUnit } from '@cold-reserve/contracts';

// °F everywhere (owner decision, 9 Oct): the unit the person chose, told by the host through its own hostContext key
// (MCP Apps allows extra keys). A host that says nothing (a real Alexa+ device) gets °C. One card per frame, so one
// value per document, like the language (#263).

/** The hostContext key the simulator sets from the demo settings. */
export const UNITS_CONTEXT_KEY = 'coldReserveUnits';

let current: TempUnit = 'C';

export const getTempUnit = (): TempUnit => current;

export function setTempUnit(unit: TempUnit): void {
  current = unit;
}

/** The unit in a host context, or undefined when it names none (or something else). */
export function unitOfContext(context: Readonly<Record<string, unknown>> | undefined): TempUnit | undefined {
  const parsed = TempUnitSchema.safeParse(context?.[UNITS_CONTEXT_KEY]);
  return parsed.success ? parsed.data : undefined;
}
