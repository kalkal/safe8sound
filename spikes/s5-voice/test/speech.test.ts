import { describe, expect, it } from 'vitest';
import { mapRecognitionError, pickVoice, type VoiceInfo } from '../src/speech';

describe('mapRecognitionError', () => {
  it.each([
    ['not-allowed', 'mic_permission_denied'],
    ['service-not-allowed', 'mic_permission_denied'],
    ['no-speech', 'no_speech'],
    ['audio-capture', 'audio_capture_failed'],
    ['network', 'recognition_network'],
    ['language-not-supported', 'language_not_supported'],
    ['bad-grammar', 'recognition_failed'],
    ['something-new', 'recognition_failed'],
  ])('%s → %s', (raw, code) => {
    expect(mapRecognitionError(raw)).toBe(code);
  });

  it('treats "aborted" as our own stop, not an error', () => {
    expect(mapRecognitionError('aborted')).toBeNull();
  });
});

describe('pickVoice', () => {
  const voices: VoiceInfo[] = [
    { name: 'Microsoft Elsa - Italian (Italy)', lang: 'it-IT', localService: true },
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true },
    { name: 'Google UK English Female', lang: 'en-GB', localService: false },
  ];

  it('prefers a network voice in the exact language when online', () => {
    expect(pickVoice(voices, 'en-US', { online: true })?.name).toBe('Google US English');
  });

  it('only picks local voices when offline', () => {
    expect(pickVoice(voices, 'en-US', { online: false })?.name).toBe('Microsoft Zira - English (United States)');
  });

  it('falls back to the same base language', () => {
    expect(pickVoice(voices.filter((v) => v.lang !== 'en-US'), 'en-US', { online: true })?.name).toBe('Google UK English Female');
  });

  it('honours an explicit voice name', () => {
    expect(pickVoice(voices, 'en-US', { online: true, preferredName: 'Microsoft Zira - English (United States)' })?.name).toBe(
      'Microsoft Zira - English (United States)',
    );
  });

  it('matches languages case- and separator-insensitively', () => {
    expect(pickVoice([{ name: 'X', lang: 'en_us', localService: true }], 'en-US', { online: true })?.name).toBe('X');
  });

  it('returns null when nothing fits', () => {
    expect(pickVoice(voices, 'ja-JP', { online: true })).toBeNull();
  });
});
