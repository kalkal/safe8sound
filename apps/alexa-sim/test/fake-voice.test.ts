import { describe, expect, it } from 'vitest';
import type { ConversationEvent } from '../src/machine.js';
import { createFakeVoice } from '../src/voice/fake-voice.js';

// The scripted voice of the E2E tests (?voice=fake, dev only): the test plays the person and the
// speakers, the page runs the real machine. Events outside an open session are dropped, like the browser.

function voice() {
  const events: ConversationEvent[] = [];
  const fake = createFakeVoice((e) => events.push(e), () => 'v1');
  return { ...fake, events };
}

describe('createFakeVoice', () => {
  it('hears words only while the mic is open', () => {
    const { recognizer, driver, events } = voice();
    expect(driver.say('ignored')).toBe(false);
    recognizer.start();
    expect(driver.listening()).toBe(true);
    expect(driver.say('battery level')).toBe(true);
    expect(driver.listening()).toBe(false);
    expect(events).toEqual([{ type: 'SPEECH_RECOGNISED', transcript: 'battery level', turnId: 'v1' }]);
  });

  it('can end without words or fail like the browser', () => {
    const { recognizer, driver, events } = voice();
    recognizer.start();
    driver.endListening();
    recognizer.start();
    driver.failListening('mic_permission_denied');
    expect(events).toEqual([{ type: 'RECOGNITION_ENDED' }, { type: 'RECOGNITION_FAILED', code: 'mic_permission_denied' }]);
  });

  it('records what is spoken and lets the test start, finish or fail the audio of the current utterance only', () => {
    const { speaker, driver, events } = voice();
    speaker.speak('Your battery is at 78 percent.');
    expect(driver.spoken()).toEqual(['Your battery is at 78 percent.']);
    expect(driver.speaking()).toBe(true);
    driver.startAudio();
    driver.finishAudio();
    expect(driver.speaking()).toBe(false);
    speaker.speak('Second.');
    speaker.cancel();
    driver.startAudio();
    driver.failAudio();
    expect(events).toEqual([{ type: 'SPEAKING_STARTED' }, { type: 'SPEAKING_ENDED' }]);
  });
});
