import '@cold-reserve/ui-cards/cards.css';
import { HomeProfileSchema, PlanSchema, PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences } from '@cold-reserve/contracts';
import { exampleHomeProfile, examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import {
  GuardReceipt,
  RefusalReceipt,
  IceCubesCard,
  PlanCard,
  PreferencesCard,
  FloorPlanCard,
  ManualControlCard,
  SafeRoomCard,
  advisoryPlan,
  cardThemeFor,
  hotDayPlan,
  inverterRefusal,
  lastResortPlan,
  planThatHolds,
  rejectedPlan,
  homeInStorm,
  safeRoomCalm,
  safeRoomInStorm,
  stormPlan,
  stormReserveRefusal,
} from '@cold-reserve/ui-cards';

// Dev-only style lab (plan §11.1bis point 8): every card on contract fixtures, in the theme the host
// would pass (`?gallery&theme=light|dark`). Used for visual checks and the per-theme screenshots.

const home = HomeProfileSchema.parse(exampleHomeProfile());
const usableWh = home.battery.usableWh;
const timeZone = home.location.tz;
/** The longest plan id the contract allows, to check wrapping at phone width. */
const longIdPlan = PlanSchema.parse({ ...rejectedPlan(), id: 'P'.repeat(64) });
const outlook = ReserveOutlookSchema.parse(exampleReserveOutlook());

export function Gallery({ hostTheme }: { hostTheme: 'light' | 'dark' | undefined }) {
  document.documentElement.dataset['cardTheme'] = cardThemeFor(hostTheme);
  return (
    <div className="gallery">
      <PlanCard plan={hotDayPlan()} timeZone={timeZone} batteryUsableWh={usableWh} />
      {/* The guard refused the model's proposal; this plan holds instead (#202, #231). */}
      <PlanCard plan={planThatHolds()} timeZone={timeZone} batteryUsableWh={usableWh} />
      <GuardReceipt plan={hotDayPlan()} />
      <GuardReceipt plan={longIdPlan} />
      <IceCubesCard outlook={outlook} />
      <PreferencesCard
        view={{
          preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())),
          isDefault: false,
          hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()),
        }}
        rooms={home.rooms}
        outlook={outlook}
      />
      <PlanCard plan={advisoryPlan()} timeZone={timeZone} batteryUsableWh={usableWh} />
      <PlanCard plan={stormPlan()} timeZone={timeZone} batteryUsableWh={usableWh} />
      <PlanCard plan={lastResortPlan()} timeZone={timeZone} batteryUsableWh={usableWh} />
      <GuardReceipt plan={lastResortPlan()} />
      <RefusalReceipt refusal={stormReserveRefusal()} />
      <RefusalReceipt refusal={inverterRefusal()} />
      <SafeRoomCard status={safeRoomInStorm()} />
      <FloorPlanCard status={homeInStorm()} />
      <ManualControlCard
        instructions={[
          { roomId: 'bedroom-1', text: 'Bedroom: dry at 26 °C' },
          { roomId: 'living', text: 'Living room: off' },
        ]}
        reason="cloud_unreachable"
      />
      <SafeRoomCard status={{ ...safeRoomCalm(), homeLink: 'stale' }} />
      {/* #114: the store cannot be read: the live reading only, at the stricter older-person limit. */}
      <SafeRoomCard status={{ ...safeRoomCalm(), storeUnavailable: true }} />
    </div>
  );
}
