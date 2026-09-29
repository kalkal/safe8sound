import '@cold-reserve/ui-cards/cards.css';
import { HomeProfileSchema, PlanSchema } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { GuardReceipt, PlanCard, advisoryPlan, cardThemeFor, hotDayPlan, rejectedPlan } from '@cold-reserve/ui-cards';

// Dev-only style lab (plan §11.1bis point 8): every card on contract fixtures, in the theme the host
// would pass (`?gallery&theme=light|dark`). Used for visual checks and the per-theme screenshots.

const home = HomeProfileSchema.parse(exampleHomeProfile());
const usableWh = home.battery.usableWh;
const timeZone = home.location.tz;
/** The longest plan id the contract allows, to check wrapping at phone width. */
const longIdPlan = PlanSchema.parse({ ...rejectedPlan(), id: 'P'.repeat(64) });

export function Gallery({ hostTheme }: { hostTheme: 'light' | 'dark' | undefined }) {
  document.documentElement.dataset['cardTheme'] = cardThemeFor(hostTheme);
  return (
    <div className="gallery">
      <PlanCard plan={hotDayPlan()} timeZone={timeZone} batteryUsableWh={usableWh} />
      <GuardReceipt plan={hotDayPlan()} />
      <GuardReceipt plan={longIdPlan} />
      <PlanCard plan={advisoryPlan()} timeZone={timeZone} batteryUsableWh={usableWh} />
    </div>
  );
}
