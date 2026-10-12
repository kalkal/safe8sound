import { HomeStatusSchema, err, ok, toolError, type HomeId, type HomeProfile, type HomeStatus } from '@cold-reserve/contracts';
import type { Clock, HomeDataSource } from '@cold-reserve/core';
import { z } from 'zod';
import type { CapabilityModule } from '../../registry.js';
import { localIso, localTimeText } from '@cold-reserve/core';
import { defineTool } from '../../tool.js';
import type { StatusDeriver } from './status-deriver.js';

export { interimStatusDeriver, type StatusDeriver } from './status-deriver.js';

/** What the server knows about a home: its data source and profile. Built by the composition root. */
export interface HomeEntry {
  readonly source: HomeDataSource;
  readonly profile: HomeProfile;
  readonly readOnly: boolean;
  readonly levelSince: string;
  /** The home's own scenario clock (C2a; a sandbox's from its settings, C2b): its simulator runs on it. */
  readonly clock?: Clock;
}

export interface EnergyStatusDeps {
  readonly homes: (homeId: HomeId) => HomeEntry | undefined;
  readonly deriver: StatusDeriver;
}

/** The text of get_home_status; the last live reading as the home's clock time, never an ISO stamp (#177). */
/** Rooms as "Name (id)": people hear the name, the model reads the id it must pass (#274). */
export const roomLabel = (id: string, names: Readonly<Record<string, string>>): string => (names[id] === undefined ? id : `${names[id]} (${id})`);

export function homeStatusSummary(
  s: HomeStatus,
  timeZone: string,
  roomNames: Readonly<Record<string, string>> = {},
  people: Readonly<Record<string, string>> = {},
): string {
  const served = s.rooms.filter((r) => r.state === 'served').length;
  const data = s.origin.energy === 'simulated' ? 'simulated data' : 'live data';
  const lastLive = s.lastLiveAt === undefined ? '' : `, last live reading at ${localTimeText(localIso(Date.parse(s.lastLiveAt), timeZone))}`;
  const link = s.homeLink === 'ok' ? '' : ` Home link ${s.homeLink}${lastLive}.`;
  // The grid in words (#273): the model reads only this text, and must never guess whether the power is back.
  const w = Math.round(Math.abs(s.gridW));
  const grid = !s.gridAvailable
    ? 'The grid is down: the home runs on the battery and the sun.'
    : s.gridW < 0
      ? `The grid is on: the home sends ${String(w)} W to it.`
      : `The grid is on: the home draws ${String(w)} W from it.`;
  // Who is in each room (#271): a fictional name with its role, "Leo (grandpa)", so the model never thinks they are two people.
  const who = (roles: readonly string[]) => (roles.length === 0 ? '' : ` with ${roles.map((r) => (people[r] === undefined ? r : `${people[r]} (${r})`)).join(' and ')}`);
  const rooms = s.rooms.length === 0 ? '' : ` Rooms: ${s.rooms.map((r) => `${roomLabel(r.roomId, roomNames)} ${r.state}${who(r.occupants)}`).join(', ')}.`;
  return `Battery at ${s.batterySocPct}%, ${s.level} level; ${served} of ${s.rooms.length} rooms served (${data}). ${grid}${rooms}${link}`;
}

export function energyStatusModule(deps: EnergyStatusDeps): CapabilityModule {
  return {
    id: 'energy-status',
    tools: [
      defineTool({
        name: 'get_home_status',
        title: 'Home status',
        description:
          'Current state of the home: battery, solar, load and grid, the pacing level and why, whether the splits can be driven, ' +
          'each room with temperature and whether it is served or waiting, and where every group of data comes from (live or simulated).',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        input: z.strictObject({}),
        output: HomeStatusSchema,
        summarize: (s) => {
          const profile = deps.homes(s.homeId)?.profile;
          return homeStatusSummary(s, profile?.location.tz ?? 'UTC', Object.fromEntries((profile?.rooms ?? []).map((r) => [r.id, r.name])), Object.fromEntries((profile?.people ?? []).map((p) => [p.role, p.name])));
        },
        handler: async (_args, ctx) => {
          const home = deps.homes(ctx.homeId);
          if (!home) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
          const read = await home.source.snapshot();
          if (!read.ok) return read;
          const snapshot = read.value;
          const derived = deps.deriver.derive({ snapshot, profile: home.profile, readOnly: home.readOnly, levelSince: home.levelSince });
          const service = new Map(derived.rooms.map((r) => [r.roomId, r]));
          return ok({
            homeId: ctx.homeId,
            ts: snapshot.ts,
            batterySocPct: snapshot.batterySocPct,
            pvW: snapshot.pvW,
            loadW: snapshot.loadW,
            gridW: snapshot.gridW,
            gridAvailable: snapshot.gridAvailable,
            ...derived.pacing,
            controlAvailability: derived.controlAvailability,
            rooms: snapshot.rooms.map((r) => {
              // A room the deriver skipped fails the output schema (a bug, reported as output_schema_violation).
              const s = service.get(r.id);
              return {
                roomId: r.id,
                tempC: r.tempC,
                ...(r.humidityPct === undefined ? {} : { humidityPct: r.humidityPct }),
                occupants: r.occupants,
                state: s?.state ?? 'waiting',
                ...(s?.waitingReason === undefined ? {} : { waitingReason: s.waitingReason }),
              };
            }),
            origin: snapshot.origin,
            homeLink: snapshot.homeLink,
            ...(snapshot.lastLiveAt === undefined ? {} : { lastLiveAt: snapshot.lastLiveAt }),
          });
        },
      }),
    ],
  };
}
