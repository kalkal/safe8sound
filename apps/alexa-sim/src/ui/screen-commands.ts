// Every button sayable (owner, idea 4): a question that is exactly the label of a button on the screen does what
// tapping it does, here on the screen, instead of going to the agent. Only the whole utterance counts ("Next" is a
// command; "what comes next" is a question), in the screen's language, with case and punctuation ignored.

import type { Log } from '../log.js';

export interface ScreenCommand {
  /** Logged as is: a fixed name, never the words said. */
  id: string;
  /** The labels that trigger it, as shown (or, for a toggle, as its other state would say). */
  phrases: readonly string[];
  run: () => void;
}

export const normaliseUtterance = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The command whose label is the whole utterance, if any; "Alexa, …" and "please" around it are allowed. */
export function matchScreenCommand(text: string, commands: readonly ScreenCommand[]): ScreenCommand | undefined {
  const said = normaliseUtterance(text)
    .replace(/^alexa /, '')
    .replace(/^please /, '')
    .replace(/ please$/, '');
  if (said === '') return undefined;
  return commands.find((command) => command.phrases.some((phrase) => normaliseUtterance(phrase) === said));
}

/** A button's label, said or typed, taps that button: true when it did, so it is not asked to the agent. */
export function runScreenCommand(text: string, turnId: string, commands: readonly ScreenCommand[], log: Log): boolean {
  const command = matchScreenCommand(text, commands);
  if (command === undefined) return false;
  // The command's fixed id only: the words said stay out of the logs.
  log({ level: 'info', code: 'screen_command', correlationId: turnId, details: { command: command.id } });
  command.run();
  return true;
}

/**
 * Previous / Next answer are sayable whenever an answer is there to step to, listening included (review of #347):
 * otherwise a spoken "Next answer" would become a turn. Not while a turn runs or failed, nor with the home open.
 */
export const pagerSayable = (screen: { thinking: boolean; failed: boolean; homeOpen: boolean; hasAnswers: boolean }): boolean =>
  !screen.thinking && !screen.failed && !screen.homeOpen && screen.hasAnswers;