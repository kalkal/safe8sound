// Design adapted from KayLerch/alexa-skill-mcp-bridge (Apache-2.0, see NOTICE): the request routing and the
// response shape. Written from scratch without the ASK SDK: only the fields this skill reads are declared.
import { z } from 'zod';

const ApplicationSchema = z.looseObject({ applicationId: z.string().min(1).max(256) });

/**
 * The part of an Alexa request envelope this skill reads. Loose objects: Alexa sends many more fields (user,
 * device, apiAccessToken...) that are never read, never validated and never logged.
 */
export const AlexaRequestEnvelopeSchema = z.looseObject({
  version: z.string().min(1).max(16),
  session: z.looseObject({ new: z.boolean().optional(), application: ApplicationSchema }).optional(),
  context: z.looseObject({ System: z.looseObject({ application: ApplicationSchema }) }),
  request: z.looseObject({
    type: z.string().min(1).max(100),
    locale: z.string().max(16).optional(),
    intent: z.looseObject({ name: z.string().min(1).max(200) }).optional(),
    /** SessionEndedRequest: USER_INITIATED, ERROR or EXCEEDED_MAX_REPROMPTS. */
    reason: z.string().max(64).optional(),
  }),
});
export type AlexaRequestEnvelope = z.infer<typeof AlexaRequestEnvelopeSchema>;

export interface OutputSpeech {
  readonly type: 'SSML';
  readonly ssml: string;
}

/** The response this skill sends: speech, an optional reprompt, and whether the session ends. */
export interface AlexaResponse {
  readonly version: '1.0';
  readonly response: {
    readonly outputSpeech?: OutputSpeech;
    readonly reprompt?: { readonly outputSpeech: OutputSpeech };
    readonly shouldEndSession?: boolean;
  };
}

/** XML-escapes plain text for SSML: our templates never carry markup, so every special character is escaped. */
export function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export const ssml = (text: string): OutputSpeech => ({ type: 'SSML', ssml: `<speak>${escapeSsml(text)}</speak>` });

/** A spoken answer. With a reprompt the session stays open; without, it ends. */
export function speak(text: string, reprompt?: string): AlexaResponse {
  return reprompt === undefined
    ? { version: '1.0', response: { outputSpeech: ssml(text), shouldEndSession: true } }
    : { version: '1.0', response: { outputSpeech: ssml(text), reprompt: { outputSpeech: ssml(reprompt) }, shouldEndSession: false } };
}

/** SessionEndedRequest and anything else that takes no speech: Alexa ignores the body. */
export const empty = (): AlexaResponse => ({ version: '1.0', response: {} });
