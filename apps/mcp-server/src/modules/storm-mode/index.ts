import { NotifyFamilyInputSchema, NotifyFamilyOutputSchema, SafeRoomStatusSchema, StartStormModeInputSchema, StartStormModeOutputSchema, type HomeId } from '@cold-reserve/contracts';
import { emergencyNumberOf } from '@cold-reserve/i18n';
import { z } from 'zod';
import type { CapabilityModule } from '../../registry.js';
import { defineTool } from '../../tool.js';
import { atHome } from '../comfort-plan/deps.js';
import type { StormModeDeps } from './deps.js';
import { notifySummary, safeRoomSummary, startSummary, type RoomLabel } from './summaries.js';
import { notifyFamily, safeRoomStatus, startStormMode } from './tools.js';

export { parseStormModeConfig, type StormModeConfig } from './config.js';
export type { ClaimedTransition, StormHome, StormModeDeps } from './deps.js';

// `storm-mode` capability module (plan §14.1, issue #23): prepare or start the storm, read the safe
// room in hours, and tell the registered family. On only for the homes the server knows.

export function stormModeModule(deps: StormModeDeps): CapabilityModule {
  return {
    id: 'storm-mode',
    enabledFor: (homeId) => deps.homes(homeId) !== undefined,
    tools: [
      defineTool({
        name: 'start_storm_mode',
        title: 'Start storm mode',
        description:
          'Prepares the home for a storm ("prepare"), or makes storm mode active ("active"). Active needs the grid measured down: ' +
          'with the grid up it only prepares, and the storm reserve stays locked. It also checks the grid first: a storm that began or ended ' +
          'is recorded and the registered family is told. With the grid up, no storm open and none in the forecast it starts nothing and ' +
          'tells no one, whatever the person said: it answers that the forecast shows no storm, and you ask the person if they want the home ' +
          'ready anyway; only after their yes, call it again with confirmed true (the family is then told it was at their request). ' +
          'Returns the safe hours of the safe room.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        input: StartStormModeInputSchema,
        output: StartStormModeOutputSchema,
        summarize: (o, ctx) => startSummary(o, roomLabel(deps, ctx.homeId), deps.config.capHours),
        handler: (args, ctx) => startStormMode(atHome(deps, ctx.homeId), args, ctx),
      }),
      defineTool({
        name: 'get_safe_room_status',
        title: 'Safe room status',
        description:
          'The safe room now: temperature, humidity, who is in it (roles), the comfort level and why, and how many hours the battery keeps it safe. Read-only.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        input: z.strictObject({}),
        output: SafeRoomStatusSchema,
        summarize: (o, ctx) => {
          const home = deps.homes(ctx.homeId);
          // #438: the number follows the home's place; with no place known none is said (never a default one, #376).
          const emergency = home?.place === undefined ? undefined : emergencyNumberOf(home.place);
          return safeRoomSummary(o, home?.units ?? 'C', roomLabel(deps, ctx.homeId), deps.config.capHours, emergency);
        },
        handler: (_args, ctx) => safeRoomStatus(atHome(deps, ctx.homeId), ctx),
      }),
      defineTool({
        name: 'notify_family',
        title: 'Notify family',
        description:
          'Sends the fixed family message for a storm transition that happened (storm_started, essential_level, power_back) to the contacts ' +
          'registered in the app, or to some of them by role. You cannot write the text or name a recipient. A person is not told the same transition again within the configured interval (power_back: once per storm). ' +
          'Call it only when the person asks to tell the family: the storm flow already tells them when a storm starts, so never on your own.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        input: NotifyFamilyInputSchema,
        output: NotifyFamilyOutputSchema,
        summarize: notifySummary,
        handler: (args, ctx) => notifyFamily(atHome(deps, ctx.homeId), args, ctx),
      }),
    ],
  };
}

/** The safe room said by its name from the home profile; never its id (#192). */
function roomLabel(deps: StormModeDeps, homeId: HomeId): RoomLabel {
  const rooms = deps.homes(homeId)?.profile.rooms ?? [];
  return (roomId) => {
    return rooms.find((r) => r.id === roomId)?.name;
  };
}
