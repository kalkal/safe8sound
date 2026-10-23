import { celsius } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { refusalWords } from '../../src/modules/comfort-plan/refusal-words.js';

// Owner, 23 Oct: a refusal the person asked for says, at once and in human terms, what was refused (in the person's
// words) and why, tied to the safe room, with one rounded number; never "Nearest allowed" (that stays in the model's
// re-plan text when no plan holds). This sentence is the card's first line and the voice's first sentence.

const rooms = [
  { id: 'bedroom-1', name: "Leo's room" },
  { id: 'bedroom-2', name: 'Second bedroom' },
  { id: 'study', name: 'Study' },
  { id: 'living', name: 'Living room' },
];
const base = { rooms, safeRoomName: "Leo's room", unit: 'C' as const, fallback: 'The plan keeps the safe room at or below 24 °C for 5 of the 8 night hours it can reach.' };

describe('the words of a refused request (owner, 23 Oct)', () => {
  it('a room named: "No — cooling the living room too: <why>", the safe room by its name', () => {
    const why = 'By 07:50 the battery would be at 67 %, not the 83 % set aside for the safe room.';
    expect(refusalWords({ ...base, input: { goal: 'cool', roomIds: ['living'] }, reason: why })).toBe(
      "No — cooling the living room too: by 07:50 the battery would be at 67 %, not the 83 % set aside for Leo's room.",
    );
  });

  it('every room at a temperature: "No — cooling every room to 21 °C: <why>"', () => {
    const why = 'Running all those rooms at once needs 8.0 kW, more than the 6.0 kW the home system can deliver; the safe room comes first.';
    expect(refusalWords({ ...base, input: { goal: 'cool', setpointC: celsius(21), roomIds: ['bedroom-1', 'bedroom-2', 'study', 'living'] }, reason: why })).toBe(
      "No — cooling every room to 21 °C: running all those rooms at once needs 8.0 kW, more than the 6.0 kW the home system can deliver; Leo's room comes first.",
    );
  });

  it('a temperature in °F is said in °F; a temperature for some rooms names them', () => {
    const why = 'That would take the battery to 34 %, below the 43 % kept back so the safe room stays cool if a storm cuts the power.';
    expect(refusalWords({ ...base, unit: 'F', input: { goal: 'cool', setpointC: celsius(22.2), roomIds: ['study'] }, reason: why })).toMatch(/^No — cooling the study to 72 °F: that would take the battery to 34 %/);
  });

  it('a night-recovery refusal uses its own sentence; a room name that starts the reason keeps its capital', () => {
    expect(refusalWords({ ...base, input: { goal: 'cool', roomIds: ['living'] }, reason: undefined })).toBe(
      "No — cooling the living room too: the plan keeps Leo's room at or below 24 °C for 5 of the 8 night hours it can reach.",
    );
    expect(refusalWords({ ...base, input: { goal: 'cool', roomIds: ['living'] }, reason: 'The safe room would reach 32 °C.' })).toBe("No — cooling the living room too: Leo's room would reach 32 °C.");
  });

  it('never longer than the contract allows (300 characters), never "Nearest allowed"', () => {
    const long = `${'The battery would be low. '.repeat(20)}Nearest allowed: 43 %.`;
    const said = refusalWords({ ...base, input: { goal: 'cool', roomIds: ['living'] }, reason: long });
    expect(said.length).toBeLessThanOrEqual(300);
    expect(said).not.toContain('Nearest allowed');
  });
});

describe('a safe room without a name of its own', () => {
  it('is said as any room: "the bedroom", never "Bedroom" in the middle of a sentence', () => {
    const said = refusalWords({ ...base, safeRoomName: 'Bedroom', input: { goal: 'cool', roomIds: ['living'] }, reason: 'The safe room would reach 32 °C.' });
    expect(said).toBe('No — cooling the living room too: the bedroom would reach 32 °C.');
  });
});

describe('the verb follows the goal (23 Oct, the Houston wording)', () => {
  it('cooling every room to 72 °F in Houston; setting a room to a warmth for any other goal', () => {
    const why = 'Running all those rooms at once needs 8.0 kW, more than the 6.0 kW the home system can deliver; the safe room comes first.';
    const all = ['bedroom-1', 'bedroom-2', 'study', 'living'];
    expect(refusalWords({ ...base, unit: 'F', input: { goal: 'cool', setpointC: celsius(22.2), roomIds: all }, reason: why })).toBe(
      "No — cooling every room to 72 °F: running all those rooms at once needs 8.0 kW, more than the 6.0 kW the home system can deliver; Leo's room comes first.",
    );
    expect(refusalWords({ ...base, input: { goal: 'heat', setpointC: celsius(24), roomIds: ['study'] }, reason: why })).toMatch(/^No — setting the study to 24 °C: /);
  });
});
