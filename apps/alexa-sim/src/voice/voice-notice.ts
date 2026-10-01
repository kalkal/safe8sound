import type { VoiceErrorCode } from '../machine.js';

type VoiceNoticeKey = 'voice.reprompt' | 'voice.typeInstead' | 'voice.micBlocked' | 'voice.silent';

const MIC_OUT: ReadonlySet<VoiceErrorCode> = new Set(['mic_permission_denied', 'language_not_supported', 'audio_capture_failed']);
const SILENT: ReadonlySet<VoiceErrorCode> = new Set(['speech_synthesis_failed', 'speech_start_missing', 'speech_end_missing']);

/** The message after a voice problem (plan §11.2 p.10): one reprompt, then text; the answer is never lost. */
export function voiceNotice({ voiceError, suggestText }: { voiceError: VoiceErrorCode | null; suggestText: boolean }): VoiceNoticeKey | null {
  if (voiceError === null) return null;
  if (SILENT.has(voiceError)) return 'voice.silent';
  if (MIC_OUT.has(voiceError)) return 'voice.micBlocked';
  return suggestText ? 'voice.typeInstead' : 'voice.reprompt';
}

type PrivacyKey = 'voice.privacy' | 'voice.privacyMic' | 'voice.privacyReplies';

/** What may leave the device (§12.4 P6): the voice to recognition, and the answers to a network voice. */
export function privacyNotice({ micAvailable, speakReplies }: { micAvailable: boolean; speakReplies: boolean }): PrivacyKey | null {
  if (micAvailable && speakReplies) return 'voice.privacy';
  if (micAvailable) return 'voice.privacyMic';
  return speakReplies ? 'voice.privacyReplies' : null;
}
