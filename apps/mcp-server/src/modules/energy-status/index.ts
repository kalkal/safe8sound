import { HomeStatusSchema, err, ok, toolError, type HomeId, type HomeProfile, type HomeStatus } from '@cold-reserve/contracts';
import type { HomeDataSource } from '@cold-reserve/core';
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
}

export interface EnergyStatusDeps {
  readonly homes: (homeId: HomeId) => HomeEntry | undefined;
  readonly deriver: StatusDeriver;
}

/** The text of get_home_status; the last live reading as the home's clock time, never an ISO stamp (#177). */
export function homeStatusSummary(s: HomeStatus, timeZone: string): string {
  const served = s.rooms.filter((r) => r.state === 'served').length;
  const data = s.origin.energy === 'simulated' ? 'simulated data' : 'live data';
  const lastLive = s.lastLiveAt === undefined ? '' : `, last live reading at ${localTimeText(localIso(Date.parse(s.lastLiveAt), timeZone))}`;
  const link = s.homeLink === 'ok' ? '' : ` Home link ${s.homeLink}${lastLive}.`;
  return `Battery at ${s.batterySocPct}%, ${s.level} level; ${served} of ${s.rooms.length} rooms served (${data}).${link}`;
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
        summarize: (s) => homeStatusSummary(s, deps.homes(s.homeId)?.profile.location.tz ?? 'UTC'),
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
