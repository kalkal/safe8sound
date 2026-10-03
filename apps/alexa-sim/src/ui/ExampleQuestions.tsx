import { t } from './text.js';

// The first screen explains itself (guided test, 3/10: "not easy to understand"): three examples that only
// fill the question field. The person still presses Ask: nothing is ever sent by an example.

/** Short labels for the buttons; the whole question goes in the field. Each one is answered by the scripted demo. */
export const EXAMPLE_QUESTIONS = [
  { label: 'examples.battery', question: "What's my battery level?" },
  { label: 'examples.hotDay', question: "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable." },
  { label: 'examples.powerCut', question: "The power's out" },
] as const;

export function ExampleQuestions({ onPick }: { onPick: (question: string) => void }) {
  return (
    <div className="examples" role="group" aria-label={t('examples.label')}>
      {EXAMPLE_QUESTIONS.map((example) => (
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
