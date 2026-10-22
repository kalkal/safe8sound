import { format } from '@cold-reserve/i18n';

// A health worry (#438, owner 22 Oct): someone may be unwell. The answer is the code's, fixed, never the model's: call the
// emergency number of the home's place (the server's, never a default), no medical advice, never "safe", and never a
// claim that anyone was called. Recognised from the person's own words, in English or Italian; in doubt it is not one,
// and the model answers as before (its prompt says the same rule).

// Not "confused" nor "not responding" alone: "I'm confused by this plan", "the app is not responding". A word that names a
// thing as well as a person is a sign only next to a person, or as something a person has (reviews of #523): "Leo
// collapsed", not "the grid collapsed"; "he has heatstroke", not "the signs of heat stroke"; "feels faint", not "a faint
// smell". "Person" means a person only, never "they" or "my <anything>" ("they said the grid collapsed", "my plan
// collapsed"), and right before the word ("the inverter won't wake up" is not one). A question about what could happen
// ("what if someone has heat stroke?", "the signs of heat stroke") is not a worry now. In doubt: not one.
const KIN = String.raw`(?:dad|mum|mom|father|mother|husband|wife|son|daughter|grandpa|grandma|grandfather|grandmother|granddad|grandad|baby|child|kid)`;
// Two kinds (third review of #523): a clear sign is a worry whatever else is said ("Leo fainted, what if it's heat
// stroke?"); a word that also names a thing counts only right after a person, and never in a "what if" question.
const PERSON = String.raw`(?:he|she|someone|somebody|leo|${KIN}|my ${KIN}|the old (?:man|woman|lady)|an old (?:man|woman|lady))`;
// "I" only where a thing cannot be meant ("I collapsed"; never "I can't wake up early tomorrow").
const PERSON_OR_I = String.raw`(?:i|${PERSON.slice(3)}`;
const PERSONA = String.raw`(?:leo|lui|lei|il nonno|la nonna|nonno|nonna|papà|mamma|mio padre|mia madre|mio marito|mia moglie|mio figlio|mia figlia)`;
const HYPOTHETICAL = /\b(?:what if|suppose|imagine|signs? of|symptoms? of|e se|i sintomi|i segni)\b/i;
/** Ambiguous words: right after a person, and not in a hypothetical question. */
const PERSON_SIGNS = [
  new RegExp(String.raw`\b${PERSON}\s+(?:won't|will not|doesn't|does not|can't|cannot)\s+wake up\b`, 'i'),
  new RegExp(String.raw`\b${PERSON_OR_I}\s+(?:has\s+|just\s+|has just\s+)?collaps(?:ed|es|ing)\b`, 'i'),
  new RegExp(String.raw`\b${PERSON}\s+(?:has|is having|had|got|has got)\s+(?:a\s+)?heat ?stroke\b`, 'i'),
  new RegExp(String.raw`\b${PERSONA}\s+(?:sta male|non sta bene|non si sente bene|si sente male|non si sveglia|è collassat[oa]|ha (?:avuto )?un colpo di calore)\b`, 'i'),
];
/** Clear signs: a worry whatever else the words say. */
const SIGNS = [
  // English
  /\bdizz(?:y|iness)\b/i,
  /\b(?:feels?|feeling|felt)\s+(?:faint|unwell|sick)\b/i,
  /\bfaint(?:ed|ing)\b/i,
  /\bunwell\b/i,
  /\b(?:not|isn't|is not|aren't)\s+feeling\s+well\b/i,
  /\bpass(?:ed|es|ing) out\b/i,
  /\bshort of breath\b/i,
  /\b(?:can't|cannot|can not|isn't|is not|not) breath(?:e|ing)\b/i,
  /\b(?:trouble|hard|struggling|struggles|difficulty|difficult)\b[^.?!]{0,15}\bbreath(?:e|ing)\b/i,
  /\bchest pains?\b/i,
  /\bunconscious\b/i,
  /\bseizure\b/i,
  // Italian
  /\bvertigin[ei]\b/i,
  /\bmi gira la testa\b/i,
  /\bsvenut[oa]\b/i,
  /\bsvien[ei]\b/i,
  /\bsta per svenire\b/i,
  /\b(?:mi sento|sto) male\b/i,
  /\bnon (?:respira|riesce a respirare)\b/i,
  /\b(?:respira a fatica|fatica a respirare|difficolt(?:à|a'|a) a respirare)\b/i,
  /\bdolor[ei] al petto\b/i,
  /\bmalore\b/i,
  // Italian drops the subject, and only a person "has" heatstroke.
  /\bha (?:avuto )?un colpo di calore\b/i,
];

/** Whether the person's words say someone may be unwell; a curly apostrophe counts as a straight one. */
export function isHealthEmergency(question: string): boolean {
  const said = question.replace(/[’‘]/g, "'");
  return SIGNS.some((sign) => sign.test(said)) || (!HYPOTHETICAL.test(said) && PERSON_SIGNS.some((sign) => sign.test(said)));
}

/** The fixed answer (English, as every answer): the place's number, or "your local emergency number" when none is known. */
export function healthEmergencyReply(emergencyNumber: string | undefined): string {
  const text = emergencyNumber === undefined ? format('en-US', 'emergency.healthLocal') : format('en-US', 'emergency.health', { number: emergencyNumber });
  // The catalog always holds both keys (the i18n tests check every key): a failure here is a bug, said honestly anyway.
  return text.ok ? text.value : "If someone may be unwell, call your local emergency number now. I can't give medical advice, and I haven't called anyone for you.";
}
