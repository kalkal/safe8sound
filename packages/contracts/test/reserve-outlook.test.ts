import { describe, expect, it } from 'vitest';
import { exampleReserveOutlook } from '../src/fixtures.js';
import { ReserveOutlookSchema } from '../src/index.js';

describe('ReserveOutlookSchema (ice cubes and reserve hours, approved in #21)', () => {
  it('parses the example outlook', () => {
    expect(ReserveOutlookSchema.parse(exampleReserveOutlook())).toMatchObject({
      level: 'comfort',
      hoursAtCurrentLevel: 9.5,
      hoursAtEssential: 18,
      reserveHoursAtEssential: 10,
    });
  });

  it('rejects negative hours and unknown levels', () => {
    expect(ReserveOutlookSchema.safeParse({ ...exampleReserveOutlook(), hoursAtCurrentLevel: -1 }).success).toBe(false);
    expect(ReserveOutlookSchema.safeParse({ ...exampleReserveOutlook(), reserveHoursAtEssential: -0.5 }).success).toBe(false);
    expect(ReserveOutlookSchema.safeParse({ ...exampleReserveOutlook(), level: 'turbo' }).success).toBe(false);
  });

  it('never lasts longer at the current level than at Essential, the most frugal one', () => {
    const outlook = { ...exampleReserveOutlook(), hoursAtCurrentLevel: 20, hoursAtEssential: 18 };
    expect(ReserveOutlookSchema.safeParse(outlook).success).toBe(false);
    expect(ReserveOutlookSchema.safeParse({ ...outlook, level: 'essential', hoursAtCurrentLevel: 18 }).success).toBe(true);
  });

  it('requires the data origin and the measurement time, and nothing else', () => {
    const withoutOrigin: Partial<ReturnType<typeof exampleReserveOutlook>> = exampleReserveOutlook();
    delete withoutOrigin.origin;
    expect(ReserveOutlookSchema.safeParse(withoutOrigin).success).toBe(false);
    expect(ReserveOutlookSchema.safeParse({ ...exampleReserveOutlook(), ts: '15 July' }).success).toBe(false);
    expect(ReserveOutlookSchema.safeParse({ ...exampleReserveOutlook(), batteryWh: 9000 }).success).toBe(false);
  });
});
