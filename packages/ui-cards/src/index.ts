/** Shared MCP Apps card components (plan §11.1): data in, callbacks out, tokens only. */
export const packageName = '@cold-reserve/ui-cards';

export { CardShell, OriginBadge } from './CardShell.js';
export { GuardReceipt } from './GuardReceipt.js';
export { PlanCard, type PlanCardProps } from './PlanCard.js';
export { advisoryPlan, hotDayPlan, rejectedPlan } from './fixtures.js';
export { levelSpans, pacingGeometry } from './plan-model.js';
export { cardThemeFor, type CardTheme } from './theme.js';
