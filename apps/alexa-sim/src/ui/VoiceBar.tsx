// The light at the bottom of the Echo screen (#432 S6). A real Echo Show with Alexa+ lights a bar at the bottom of
// the screen: it pulses while listening, moves as a wave from left to right while thinking, and rests as a small fixed
// light while it is ready to listen without the wake word (Follow Up) (Amazon Help "Indicators for Alexa+ on Echo
// Devices with a Screen"). Ours keeps the place and the behaviour, with our own colour and shape (owner Q2, 18 Oct:
// never Alexa's blue). Off while the answer is spoken. Screen readers get the same in words from the status line.

export const VOICE_BAR_STATES = ['off', 'ready', 'listening', 'thinking'] as const;
export type VoiceBarState = (typeof VOICE_BAR_STATES)[number];

export function voiceBarState(o: { listening: boolean; thinking: boolean; speaking: boolean; followUp: boolean }): VoiceBarState {
  if (o.listening) return 'listening';
  if (o.thinking) return 'thinking';
  if (o.speaking) return 'off';
  return o.followUp ? 'ready' : 'off';
}

export function VoiceBar({ state }: { state: VoiceBarState }) {
  return (
    <div className="voice-bar" data-testid="voice-bar" data-state={state} aria-hidden="true">
      <span className="voice-bar-light" />
    </div>
  );
}
