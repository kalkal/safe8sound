import { t } from './text.js';

// The first screen explains itself (guided test, 3/10: "not easy to understand"): three examples that only
// fill the question field. The person still presses Ask: nothing is ever sent by an example.

/** Short labels for the buttons; the whole question goes in the field. Each one is answered by the scripted demo. */
export const EXAMPLE_QUESTIONS = [
  { label: 'examples.battery', question: "What's my battery level?" },
  { label: 'examples.hotDay', question: "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable." },
  { label: 'examples.powerCut', question: "The power's out" },
] as const;

/** With the grid down (#268): what matters during a storm, never a hot-day plan. */
export const STORM_EXAMPLE_QUESTIONS = [
  { label: 'examples.safeRoom', question: 'How is Grandpa doing in the safe room?' },
  // Never "battery" here: the scripted demo would answer the battery level (review of #301).
  { label: 'examples.howLong', question: 'How long will the cold reserve last?' },
  { label: 'examples.powerBack', question: 'Is the power back?' },
] as const;

export type ExampleQuestion = (typeof EXAMPLE_QUESTIONS)[number] | (typeof STORM_EXAMPLE_QUESTIONS)[number];

/** What the simulator already knows: the home's grid (once read) and the demo scenario. */
export interface ExampleState {
  readonly gridAvailable?: boolean;
  readonly scenarioId?: string;
}

/** The home read wins; before it, the scenario decides (#268). */
export function examplesFor(state: ExampleState): readonly ExampleQuestion[] {
  const gridDown = state.gridAvailable === undefined ? state.scenarioId === 'storm-blackout' : !state.gridAvailable;
  return gridDown ? STORM_EXAMPLE_QUESTIONS : EXAMPLE_QUESTIONS;
}

export function ExampleQuestions({ onPick, examples = EXAMPLE_QUESTIONS }: { onPick: (question: string) => void; examples?: readonly ExampleQuestion[] }) {
  return (
    <div className="examples" role="group" aria-label={t('examples.label')}>
      {examples.map((example) => (
        <button
          key={example.label}
          type="button"
          className="chip-button"
          onClick={() => {
            onPick(example.question);
          }}
        >
          {t(example.label)}
        </button>
      ))}
    </div>
  );
}
