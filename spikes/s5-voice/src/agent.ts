/** Deterministic stand-in for the real agent (the future `ScriptedAgent`). Replies are at most 2 sentences (plan §11.2 point 10). */
const SCRIPT: ReadonlyArray<[RegExp, string]> = [
  [/cool|bedroom|how long/i, 'The bedroom stays cool until at least 7 am. I am keeping 6 kilowatt hours for the storm.'],
  [/storm|ready/i, 'Storm mode is ready. I will ask before changing anything.'],
  [/status|battery|reserve/i, 'The battery is at 78 percent. That is about 14 hours of comfort in the bedroom.'],
];
const FALLBACK = 'Sorry, I did not get that. You can ask how long the bedroom stays cool.';

export function scriptedReply(transcript: string): string {
  return SCRIPT.find(([re]) => re.test(transcript))?.[1] ?? FALLBACK;
}

export function createScriptedAgent(delayMs: number) {
  return (transcript: string) =>
    new Promise<string>((resolve) => {
      setTimeout(() => resolve(scriptedReply(transcript)), delayMs);
    });
}
