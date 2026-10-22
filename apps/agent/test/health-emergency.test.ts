import { describe, expect, it } from 'vitest';
import { healthEmergencyReply, isHealthEmergency } from '../src/health-emergency.js';

// #438, owner 22 Oct: when someone may be unwell the answer is fixed, by the code and never the model: call the emergency
// number of the home's place (112 in Turin and the European reference home, 911 in Houston, "your local emergency number"
// when the place is unknown), no medical advice, never "safe", and never a claim that anyone was called.

describe('a health emergency is recognised by the code', () => {
  it.each([
    'Leo feels dizzy and confused.',
    'Grandpa fainted',
    "He can't breathe well",
    'Leo is short of breath',
    'My father has chest pain',
    'Leo is unconscious',
    'He collapsed in the bedroom',
    'I think Leo has heatstroke',
    'Leo ha le vertigini',
    'Il nonno è svenuto',
    'Leo non respira bene',
    'Ha un malore',
  ])('"%s"', (question) => {
    expect(isHealthEmergency(question)).toBe(true);
  });

  it.each(["I'm confused by this plan", 'The app is not responding', 'Sono confusa, che piano è?', 'Is Leo safe?', "Keep Leo cool, it's going to be 36 tomorrow.", "What's my battery level?", 'Leo is asleep', 'The power is out'])('not "%s"', (question) => {
    expect(isHealthEmergency(question)).toBe(false);
  });
});

describe('the fixed answer, with the number of the place', () => {
  it('names the number first, gives no medical advice, never says safe, and never claims a call', () => {
    for (const [number, expected] of [['112', 'call 112 now'], ['911', 'call 911 now']] as const) {
      const text = healthEmergencyReply(number);
      expect(text).toMatch(new RegExp(`^If someone may be unwell, ${expected}\\.`));
      expect(text).not.toMatch(/\bsafe\b/i);
      expect(text).not.toMatch(/(?:I(?:'ve| have)? called|calling|help is on the way)/i);
      expect(text).toMatch(/medical advice/);
    }
  });

  it('a place without a known number: "your local emergency number", never a made-up one', () => {
    const text = healthEmergencyReply(undefined);
    expect(text).toMatch(/^If someone may be unwell, call your local emergency number now\./);
    expect(text).not.toMatch(/\d/);
  });
});

describe('reviews of #523: recall and precision', () => {
  it.each([
    'Leo feels unwell',
    "Grandpa isn't feeling well",
    'He is not feeling well',
    'Leo has trouble breathing',
    "He’s struggling to breathe",
    'It is hard to breathe for him',
    "Leo won't wake up",
    'Grandpa feels faint',
    'He has heatstroke',
    'Leo is having a heat stroke',
    'Leo collapsed',
    'Il nonno sta male',
    'Leo si sente male',
    'Mi gira la testa',
    'Non riesce a respirare',
    'Respira a fatica',
    'Ha difficoltà a respirare',
    'Ha dolori al petto',
    'Sta per svenire',
    'Ha un colpo di calore',
  ])('"%s" is a health worry', (question) => {
    expect(isHealthEmergency(question)).toBe(true);
  });

  it.each(['What are the signs of heat stroke?', 'The grid collapsed', 'There is a faint smell in the kitchen', 'The roof collapsed under the snow', 'I see a faint light on the inverter'])('"%s" is not', (question) => {
    expect(isHealthEmergency(question)).toBe(false);
  });
});

describe('second review of #523: on camera, no false alarm and no miss', () => {
  it.each([
    'The inverter won\'t wake up',
    'My Echo won\'t wake up',
    'My plan collapsed',
    'They said the grid collapsed',
    'What if someone has heat stroke?',
    'Questo colore sta male',
  ])('"%s" is not a health worry', (question) => {
    expect(isHealthEmergency(question)).toBe(false);
  });

  it.each([
    'Someone collapsed',
    'I collapsed',
    'The old man collapsed',
    'Leo non si sveglia',
    'Leo è collassato',
    'difficolta a respirare',
    'Il nonno non sta bene',
  ])('"%s" is a health worry', (question) => {
    expect(isHealthEmergency(question)).toBe(true);
  });
});

describe('third review of #523: a clear sign wins over a "what if", and things never "feel" ill', () => {
  it.each([
    "Leo fainted, what if it's heat stroke?",
    'Grandpa fainted and shows signs of heat stroke',
    'Il nonno è svenuto, e se non si sveglia?',
    'Leo non si sveglia',
    'Il nonno si sente male',
    'Leo è collassato',
    'Mi sento male',
  ])('"%s" is a health worry', (question) => {
    expect(isHealthEmergency(question)).toBe(true);
  });

  it.each(["I can't wake up early tomorrow", "L'Echo si sente male", "L'inverter non si sveglia", 'La rete è collassata', 'What if someone has heat stroke?'])('"%s" is not', (question) => {
    expect(isHealthEmergency(question)).toBe(false);
  });
});
