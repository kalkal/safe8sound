// Design adapted from KayLerch/alexa-skill-mcp-bridge (Apache-2.0, see NOTICE): Stop, Cancel and NavigateHome
// share one goodbye, SessionEndedRequest gets an empty response, the skill ID is checked in code as well as by the
// Lambda permission. The rest (no model, fixed templates, errors as values) is this project's own.
import { err, ok, toolError, type ErrorEnvelope, type LogEntry, type Result, type TempUnit } from '@cold-reserve/contracts';
import { AlexaRequestEnvelopeSchema, empty, speak, type AlexaRequestEnvelope, type AlexaResponse } from './alexa.js';
import { callSkillTool, type CallFailure, type McpCaller, type SkillTool, type SkillToolOutput } from './mcp.js';
import { DEMO_HOME, FALLBACK, GOODBYE, HELP, REPROMPT, failureSpeech, homeStatusSpeech, reserveOutlookSpeech, safeRoomSpeech } from './speech.js';

/** Each request that reads the home, and the tool it calls. Nothing else reaches the MCP server. */
export const INTENT_TOOLS = {
  LaunchRequest: 'get_home_status',
  ReserveOutlookIntent: 'get_reserve_outlook',
  SafeRoomIntent: 'get_safe_room_status',
} as const satisfies Readonly<Record<string, SkillTool>>;

/** The built-in intents the skill answers without a tool. */
export const BUILT_IN_INTENTS = ['AMAZON.HelpIntent', 'AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.FallbackIntent'] as const;

export interface SkillTiming {
  /** The whole request, inside Alexa's 8 s and the function's 7 s. */
  readonly deadlineMs: number;
  /** Reading the MCP token from SSM (only on a cold container: a success is kept). */
  readonly ssmTimeoutMs: number;
  /** The one MCP call. */
  readonly mcpTimeoutMs: number;
}

export interface SkillDeps {
  /** The skill this function serves; any other applicationId is refused before the MCP server is called. */
  readonly skillId: string;
  /** The MCP token (SSM SecureString), kept after the first success. */
  readonly token: () => Promise<Result<string, ErrorEnvelope>>;
  readonly caller: McpCaller;
  readonly timing: SkillTiming;
  readonly tempUnit: TempUnit;
  readonly log: (entry: LogEntry) => void;
  readonly newId: () => string;
  readonly now: () => number;
}

const COMPONENT = 'alexa-skill';

type Route = { kind: 'tool'; tool: SkillTool; launch: boolean } | { kind: 'help' } | { kind: 'stop' } | { kind: 'fallback'; known: boolean } | { kind: 'ended' } | { kind: 'ignored' };

function routeOf(request: AlexaRequestEnvelope['request']): Route {
  if (request.type === 'LaunchRequest') return { kind: 'tool', tool: INTENT_TOOLS.LaunchRequest, launch: true };
  if (request.type === 'SessionEndedRequest') return { kind: 'ended' };
  if (request.type !== 'IntentRequest') return { kind: 'ignored' };
  const name = request.intent?.name ?? '';
  if (name === 'ReserveOutlookIntent' || name === 'SafeRoomIntent') return { kind: 'tool', tool: INTENT_TOOLS[name], launch: false };
  if (name === 'AMAZON.HelpIntent') return { kind: 'help' };
  if (name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent' || name === 'AMAZON.NavigateHomeIntent') return { kind: 'stop' };
  return { kind: 'fallback', known: name === 'AMAZON.FallbackIntent' };
}

/** Rejects when the signal aborts: the step that waits on it stops waiting. */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });

/**
 * One Alexa request in, one Alexa response out. Never throws: every failure is a short spoken apology, and the
 * detail goes to one JSON log line with the correlation id. The log never carries the user, device or session
 * ids, the apiAccessToken, the MCP token or any error text.
 */
export async function handle(raw: unknown, deps: SkillDeps): Promise<AlexaResponse> {
  const correlationId = deps.newId();
  const started = deps.now();
  const line = (entry: Omit<LogEntry, 'ts' | 'component' | 'correlationId'>) => {
    deps.log({ ts: new Date(deps.now()).toISOString(), component: COMPONENT, correlationId, ...entry });
  };
  const fail = (failure: CallFailure | { error: ErrorEnvelope; source: 'config'; errorName?: string }, details: Record<string, unknown>): AlexaResponse => {
    const { error } = failure;
    line({
      level: error.category === 'internal' || error.category === 'unauthorized' ? 'error' : 'warn',
      message: `The skill answered with an apology: ${error.code} (${failure.source}).`,
      code: error.code,
      category: error.category,
      ...(failure.errorName === undefined ? {} : { errorName: failure.errorName }),
      details: { ...details, durationMs: deps.now() - started },
    });
    return speak(failureSpeech(error));
  };

  try {
    const parsed = AlexaRequestEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      line({ level: 'warn', message: 'The request is not an Alexa request envelope.', code: 'invalid_input', category: 'validation' });
      return speak(FALLBACK);
    }
    const envelope = parsed.data;
    // Second check of the skill ID (the first is the Lambda permission's EventSourceToken).
    const ids = [envelope.context.System.application.applicationId, envelope.session?.application.applicationId].filter((id) => id !== undefined);
    if (ids.some((id) => id !== deps.skillId)) {
      line({ level: 'warn', message: 'A request for another skill was refused.', code: 'wrong_client', category: 'unauthorized', details: { requestType: envelope.request.type } });
      return empty();
    }

    const route = routeOf(envelope.request);
    const details = { requestType: envelope.request.type, ...(envelope.request.intent === undefined ? {} : { intent: envelope.request.intent.name.slice(0, 64) }) };
    const done = (response: AlexaResponse, extra: Record<string, unknown> = {}) => {
      line({ level: 'info', message: 'Alexa request answered.', details: { ...details, ...extra, durationMs: deps.now() - started } });
      return response;
    };

    switch (route.kind) {
      case 'ended':
        return done(empty(), envelope.request.reason === undefined ? {} : { reason: envelope.request.reason });
      case 'ignored':
        return done(empty());
      case 'help':
        return done(speak(HELP, REPROMPT));
      case 'stop':
        return done(speak(GOODBYE));
      case 'fallback':
        if (!route.known) {
          line({ level: 'warn', message: 'An intent the skill does not know.', code: 'invalid_input', category: 'validation', details });
        }
        return done(speak(FALLBACK, REPROMPT));
      case 'tool':
        break;
    }

    const deadline = AbortSignal.timeout(deps.timing.deadlineMs);
    const token = await readToken(deps, deadline);
    if (!token.ok) return fail({ error: token.error, source: 'config' }, { ...details, tool: route.tool });

    const signal = AbortSignal.any([deadline, AbortSignal.timeout(deps.timing.mcpTimeoutMs)]);
    const answer = await answerFor(route.tool, deps, { token: token.value, signal, correlationId });
    if (!answer.ok) return fail(answer.error, { ...details, tool: route.tool });

    const text = route.launch ? `${DEMO_HOME} ${answer.value}` : answer.value;
    // A one-shot request ("ask ... how long the reserve lasts") ends with the answer; an open session continues.
    const keepOpen = route.launch || envelope.session?.new === false;
    return done(keepOpen ? speak(text, REPROMPT) : speak(text), { tool: route.tool });
  } catch (e) {
    return fail({ error: toolError('unexpected_error', 'The skill failed unexpectedly.'), source: 'config', errorName: e instanceof Error ? e.name.slice(0, 80) : typeof e }, {});
  }
}

async function readToken(deps: SkillDeps, deadline: AbortSignal): Promise<Result<string, ErrorEnvelope>> {
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(deps.timing.ssmTimeoutMs)]);
  try {
    return await Promise.race([deps.token(), aborted(signal)]);
  } catch {
    return err(toolError('config_unavailable', `The MCP token could not be read within ${String(deps.timing.ssmTimeoutMs)} ms.`));
  }
}

async function answerFor(tool: SkillTool, deps: SkillDeps, opts: { token: string; signal: AbortSignal; correlationId: string }): Promise<Result<string, CallFailure>> {
  const say = <T extends SkillTool>(name: T, text: (o: SkillToolOutput[T]) => string) =>
    callSkillTool(deps.caller, name, opts).then((r): Result<string, CallFailure> => (r.ok ? ok(text(r.value)) : r));
  switch (tool) {
    case 'get_home_status':
      return say('get_home_status', homeStatusSpeech);
    case 'get_reserve_outlook':
      return say('get_reserve_outlook', reserveOutlookSpeech);
    case 'get_safe_room_status':
      return say('get_safe_room_status', (s) => safeRoomSpeech(s, deps.tempUnit));
  }
}
