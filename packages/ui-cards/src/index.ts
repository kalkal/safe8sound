/** Shared MCP Apps card components (plan §11.1): data in, callbacks out, tokens only. */
export const packageName = '@cold-reserve/ui-cards';

export { CARD_WAITING_MIN_PX, CardApp, type CardAppProps } from './app/CardApp.js';
export {
  BUNDLE_BUDGET_BYTES,
  CARD_KINDS,
  checkBundleSize,
  isCardKind,
  isStormState,
  parseCardResult,
  renderCardHtml,
  type CardAssets,
  type CardKind,
  type CardState,
  type ToolResultLike,
} from './app/card-kinds.js';
export { CardShell, OriginBadge } from './CardShell.js';
export { GuardReceipt, RefusalReceipt } from './GuardReceipt.js';
export { CUBES_PER_ROW, CubeRow, cubeFills, cubesLabel } from './CubeRow.js';
export { IceCubesCard } from './IceCubesCard.js';
export { formatHours } from './text.js';
export { PlanCard, type PlanCardProps } from './PlanCard.js';
export { PreferencesCard, type PreferencesCardProps } from './PreferencesCard.js';
export { FloorPlanCard } from './FloorPlanCard.js';
export { ManualControlCard, type ManualReason } from './ManualControlCard.js';
export { SafeRoomCard } from './SafeRoomCard.js';
export { DEMO_CONTEXT_KEY, TAP_MARK_MS, installTapMarks, isDemoContext } from './demo-taps.js';
export { UNITS_CONTEXT_KEY, getTempUnit, setTempUnit, unitOfContext } from './temp-unit.js';
export { homeCalm, homeInStorm } from './home-fixtures.js';
export { advisoryPlan, hotDayPlan, inverterRefusal, lastResortPlan, planThatHolds, rejectedPlan, safeRoomAboveNightLimit, safeRoomCalm, safeRoomInStorm, stormPlan, stormReserveRefusal, surplusPlan } from './fixtures.js';
export { homeClock, levelSpans, pacingGeometry } from './plan-model.js';
export { cardThemeFor, type CardTheme } from './theme.js';
