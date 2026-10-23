import { formatTemp, type PlanComfortInput, type TempUnit } from '@cold-reserve/contracts';

// The words of a refused request the person asked for (owner, 23 Oct): "No — <what they asked, in their words>: <why>".
// The why is the guard's own sentence (human terms, one rounded number), with "the safe room" said by its name; never
// "Nearest allowed" (it stays in the model's re-plan text when no plan holds). It is the card's first line and the
// voice's first sentence (plan.refusedProposal). At most 300 characters, as the contract allows.

const MESSAGE_MAX = 300;

/** A room as a person says it: "Leo's room" as it is, "Living room" as "the living room". */
const said = (name: string) => (name.includes("'") ? name : `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`);

const list = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`);

/** What the person asked for, in their words: a temperature for rooms, or more rooms. */
function whatOf(input: PlanComfortInput, rooms: readonly { id: string; name: string }[], unit: TempUnit): string {
  const asked = input.roomIds ?? [];
  const every = asked.length === 0 || rooms.every((r) => asked.includes(r.id));
  const names = list(asked.map((id) => said(rooms.find((r) => r.id === id)?.name ?? id)));
  // The verb follows the goal: "cooling every room to 72 °F" on a hot day, "setting the study to 24 °C" otherwise.
  const verb = input.goal === 'cool' ? 'cooling' : 'setting';
  if (input.setpointC !== undefined) return `${verb} ${every ? 'every room' : names} to ${formatTemp(input.setpointC, unit)}`;
  return asked.length === 0 ? 'that plan' : `cooling ${names} too`;
}

export function refusalWords(o: {
  input: PlanComfortInput;
  /** The first failing guarantee's reason, or undefined for a night-recovery refusal (then `fallback`, its own sentence). */
  reason: string | undefined;
  fallback: string;
  rooms: readonly { id: string; name: string }[];
  safeRoomName: string;
  unit: TempUnit;
}): string {
  // The safe room as a person says it: "Leo's room", or "the bedroom" for a room named "Bedroom".
  const room = said(o.safeRoomName);
  const why = (o.reason ?? o.fallback).replace(/\s*Nearest allowed:.*$/, '').replace(/\bthe safe room\b/gi, room);
  // "By 07:50 …" reads "No — …: by 07:50 …"; a name of its own ("Leo's room") keeps its capital.
  const tail = room.includes("'") && why.startsWith(room) ? why : `${why.charAt(0).toLowerCase()}${why.slice(1)}`;
  const text = `No — ${whatOf(o.input, o.rooms, o.unit)}: ${tail}`;
  return text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX - 1)}…`;
}
