import { HomeIdSchema, StormIdSchema, StormSessionSchema, type Level, type StormSession } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stormReduce, type StormContext, type StormEvent } from '../src/storm-session.js';

const T0 = Date.parse('2026-07-17T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const ctx: StormContext = {
  homeId: HomeIdSchema.parse('demo'),
  newId: () => StormIdSchema.parse('storm_abcdefgh01'),
  safeRoomId: 'bedroom-1',
  occupantRoles: ['grandpa'],
  hoursAtEssential: 18,
  autoStormOnGridLoss: true,
  stableGridMinutes: 10,
};
const reading = (minutes: number, gridAvailable: boolean, level: Level = 'comfort', previousLevel: Level = 'comfort'): StormEvent => ({
  type: 'reading',
  at: at(minutes),
  gridAvailable,
  level,
  previousLevel,
});

function run(events: readonly StormEvent[], start?: StormSession) {
  let session = start;
  const transitions: string[] = [];
  for (const event of events) {
    const next = stormReduce(session, event, ctx);
    session = next.session;
    transitions.push(...next.transitions);
  }
  return { session, transitions };
}

describe('stormReduce: the storm session as a pure state machine (plan §9.2)', () => {
  it('opens a prepare session when the person asks, and only says so (no message)', () => {
    const { session, transitions } = run([{ type: 'request', mode: 'prepare', trigger: 'user', at: at(0), gridAvailable: true }]);
    expect(session).toMatchObject({ phase: 'prepare', trigger: 'user', startedAt: at(0) });
    expect(transitions).toEqual(['storm_prepared']);
  });

  it('turns "active" into prepare while the grid is up', () => {
    const { session } = run([{ type: 'request', mode: 'active', trigger: 'user', at: at(0), gridAvailable: true }]);
    expect(session?.phase).toBe('prepare');
  });

  it('becomes active on a measured grid loss, once', () => {
    const { session, transitions } = run([
      { type: 'request', mode: 'prepare', trigger: 'user', at: at(0), gridAvailable: true },
      reading(60, false),
      reading(61, false),
    ]);
    expect(session).toMatchObject({ phase: 'active', activeAt: at(60) });
    expect(transitions).toEqual(['storm_prepared', 'storm_started']);
  });

  it('starts by itself on a grid loss when the person pre-authorised it, and not otherwise', () => {
    expect(run([reading(0, false)]).session).toMatchObject({ phase: 'active', trigger: 'grid_loss', activeAt: at(0) });
    const manual = stormReduce(undefined, reading(0, false), { ...ctx, autoStormOnGridLoss: false });
    expect(manual).toEqual({ session: undefined, transitions: [] });
  });

  it('announces the essential level once, when it is reached', () => {
    const { transitions } = run([reading(0, false), reading(30, false, 'saver', 'balanced'), reading(60, false, 'essential', 'saver'), reading(90, false, 'essential', 'essential')]);
    expect(transitions).toEqual(['storm_started', 'essential_level']);
  });

  it('ends only after the grid has been back and stable for the configured minutes, then says power is back', () => {
    const { session, transitions } = run([reading(0, false), reading(600, true), reading(605, true), reading(610, true)]);
    expect(session).toMatchObject({ phase: 'ended', gridBackAt: at(600), endedAt: at(610) });
    expect(transitions).toEqual(['storm_started', 'power_back']);
  });

  it('restarts the stable-grid window when the grid drops again', () => {
    const { session, transitions } = run([reading(0, false), reading(600, true), reading(605, false), reading(612, true), reading(620, true)]);
    expect(session?.phase).toBe('active');
    expect(session?.gridBackAt).toBe(at(612));
    expect(transitions).toEqual(['storm_started']);
  });

  it('lets the person cancel a prepared storm; an active one ends only with the grid', () => {
    const prepared = run([{ type: 'request', mode: 'prepare', trigger: 'user', at: at(0), gridAvailable: true }, { type: 'cancel', at: at(30) }]);
    expect(prepared.session).toMatchObject({ phase: 'ended', endedAt: at(30) });
    const active = run([reading(0, false), { type: 'cancel', at: at(30) }]);
    expect(active.session?.phase).toBe('active');
  });

  it('starts a new session after an ended one', () => {
    const { session } = run([reading(0, false), reading(600, true), reading(610, true), reading(700, false)]);
    expect(session).toMatchObject({ phase: 'active', startedAt: at(700) });
  });

  it('always produces a valid StormSession, and never more than one transition per event (property)', () => {
    const event = fc.oneof(
      fc.record({ kind: fc.constant('reading'), grid: fc.boolean(), level: fc.constantFrom('comfort', 'balanced', 'saver', 'essential') }),
      fc.record({ kind: fc.constant('request'), mode: fc.constantFrom('prepare', 'active'), grid: fc.boolean() }),
      fc.record({ kind: fc.constant('cancel') }),
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (steps) => {
        let session: StormSession | undefined;
        let previousLevel: 'comfort' | 'balanced' | 'saver' | 'essential' = 'comfort';
        steps.forEach((step, i) => {
          const when = at(i * 5);
          const e: StormEvent =
            step.kind === 'reading'
              ? { type: 'reading', at: when, gridAvailable: step.grid, level: step.level, previousLevel }
              : step.kind === 'request'
                ? { type: 'request', mode: step.mode, trigger: 'user', at: when, gridAvailable: step.grid }
                : { type: 'cancel', at: when };
          if (step.kind === 'reading') previousLevel = step.level;
          const next = stormReduce(session, e, ctx);
          expect(next.transitions.length).toBeLessThanOrEqual(1);
          if (next.session) expect(StormSessionSchema.safeParse(next.session).success).toBe(true);
          session = next.session;
        });
      }),
    );
  });
});
