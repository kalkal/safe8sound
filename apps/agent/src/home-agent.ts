import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type TurnReply } from '@cold-reserve/contracts';
import type { Model } from '@strands-agents/sdk';
import { createAgent, type ColdReserveAgent } from './agent.js';
import type { AgentConfig } from './config.js';
import { classifyFailure } from './failure.js';
import { logLine, type AgentLogEntry } from './log.js';
import type { HomeAgent } from './invocations.js';
import { createTurnRecorder, mcpToolset, type McpSession, type TurnRecorder } from './mcp-tools.js';
import { replyText } from './reply-text.js';
import { healthEmergencyReply, isHealthEmergency } from './health-emergency.js';

/** One running turn and one waiting: a third question for the same home is refused (review of #132). */
const MAX_TURNS_PER_HOME = 2;

/**
 * One sandbox home: its own agent (conversation history), its own MCP session (opened on the first
 * turn, with the home header set by the code) and the cards of each turn.
 */
export function createHomeAgent(deps: {
  config: AgentConfig;
  home: HomeId;
  model: Model;
  connect: (home: HomeId) => Promise<McpSession>;
  log?: (entry: AgentLogEntry) => void;
  /** Wall clock in ms, injected in tests. */
  now?: () => number;
}): HomeAgent {
  const now = deps.now ?? Date.now;
  interface Built {
    agent: ColdReserveAgent;
    recorder: TurnRecorder;
    session: McpSession;
  }
  let ready: Promise<Built> | undefined;

  // Each agent has its own recorder: after a timeout a fresh pair is built, so a Strands run that is
  // still finishing writes into its own recorder, never into the next turn's cards.
  const start = async (): Promise<Built> => {
    const recorder = createTurnRecorder();
    const session = await deps.connect(deps.home);
    const tools = await mcpToolset(session, recorder, deps.log);
    return { agent: createAgent({ config: deps.config, model: deps.model, tools, ...(deps.log ? { log: deps.log } : {}) }), recorder, session };
  };

  /**
   * The fixed answer to a health worry (#438, owner 22 Oct): the safe room read by the code (its card comes with the
   * answer), its place's number said first; with the server down or no number, "your local emergency number". One info
   * line, never the person's words.
   */
  const healthEmergencyTurn = async (session: McpSession, recorder: TurnRecorder, correlationId: string, leftMs: number): Promise<TurnReply> => {
    let number: string | undefined;
    try {
      // The turn's own deadline, never the SDK's 60 s (review of #523).
      const status = await session.callTool('get_safe_room_status', {}, AbortSignal.timeout(Math.max(1, leftMs)), correlationId);
      const found = status.isError === true ? undefined : status.structuredContent?.['emergencyNumber'];
      if (typeof found === 'string' && /^\d{3}$/.test(found)) number = found;
      if (status.isError !== true) recorder.record('get_safe_room_status', status.structuredContent);
    } catch (e) {
      // The answer never waits for the room: without it, the local emergency number.
      deps.log?.({ ...logLine(toolError('agent_unavailable', 'The safe room could not be read for a health worry.'), e instanceof Error ? e.name : typeof e, { correlationId }), level: 'warn' });
    }
    deps.log?.({ ts: new Date(now()).toISOString(), level: 'info', component: 'agent', message: 'health_emergency_answer', correlationId, details: { event: 'health_emergency_answer', numberKnown: number !== undefined } });
    const cards = recorder.cards();
    return { text: healthEmergencyReply(number), ...(cards.length === 0 ? {} : { cards: [...cards] }) };
  };
  /** No session to read the room (it could not open, or opened too late): the fixed answer with the local number. */
  const healthEmergencyWithoutRoom = (correlationId: string): TurnReply => {
    deps.log?.({ ts: new Date(now()).toISOString(), level: 'info', component: 'agent', message: 'health_emergency_answer', correlationId, details: { event: 'health_emergency_answer', numberKnown: false } });
    return { text: healthEmergencyReply(undefined) };
  };

  const turn = async (question: string, correlationId: string, arrivedAt: number): Promise<Result<TurnReply, ErrorEnvelope>> => {
    // A health worry (#438, owner 22 Oct) is known before anything is waited for (review of #523): whatever fails next,
    // the person still hears the fixed answer, never an error.
    const health = isHealthEmergency(question);
    // Waited too long for the previous turn: answer now, and keep the agent (this turn never started).
    const deadlineMs = deps.config.turnDeadlineMs - (now() - arrivedAt);
    if (deadlineMs <= 0 && health) return ok(healthEmergencyWithoutRoom(correlationId));
    if (deadlineMs <= 0) {
      const timeout = toolError('agent_timeout', 'The assistant took too long to answer. Try again in a moment.');
      deps.log?.(logLine(timeout, 'TurnDeadline', { correlationId }));
      return err(timeout);
    }
    let built: Built | 'timeout';
    const starting = (ready ??= start());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Opening the MCP session counts toward the deadline too (review of #121).
      built = await Promise.race([
        starting,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout');
          }, deadlineMs);
        }),
      ]);
    } catch (e) {
      ready = undefined; // the next turn tries to connect again
      const failure = classifyFailure(e);
      if (failure.kind === 'bug') throw failure.error;
      deps.log?.(logLine(failure.error, e instanceof Error ? e.name : typeof e, { correlationId, httpStatus: failure.httpStatus, cause: e instanceof Error ? e.cause : undefined }));
      return health ? ok(healthEmergencyWithoutRoom(correlationId)) : err(failure.error);
    } finally {
      clearTimeout(timer);
    }
    if (built === 'timeout') {
      // The next turn connects again; a session that opens late is closed, never used.
      ready = undefined;
      starting.then(
        (late) => late.session.close?.(),
        (e: unknown) => {
          // Too late to be this turn's answer, but still worth a line.
          deps.log?.(logLine(toolError('agent_unavailable', 'A late MCP session failed to open.'), e instanceof Error ? e.name : typeof e, { correlationId }));
        },
      ).catch((e: unknown) => {
        deps.log?.(logLine(toolError('agent_unavailable', 'A late MCP session could not be closed.'), e instanceof Error ? e.name : typeof e, { correlationId }));
      });
      const timeout = toolError('agent_timeout', 'The assistant took too long to answer. Try again in a moment.');
      deps.log?.(logLine(timeout, 'TurnDeadline', { correlationId }));
      return health ? ok(healthEmergencyWithoutRoom(correlationId)) : err(timeout);
    }
    const { agent, recorder, session } = built;
    // Waiting for the previous turn AND opening the session both count: the model gets only what is
    // left (review of #139). Nothing started yet, so the agent and its session are kept.
    const leftMs = deps.config.turnDeadlineMs - (now() - arrivedAt);
    if (leftMs <= 0 && health) return ok(healthEmergencyWithoutRoom(correlationId));
    if (leftMs <= 0) {
      const timeout = toolError('agent_timeout', 'The assistant took too long to answer. Try again in a moment.');
      deps.log?.(logLine(timeout, 'TurnDeadline', { correlationId }));
      return err(timeout);
    }
    recorder.reset(correlationId, question);
    // A health worry (#438, owner 22 Oct): the code's fixed answer, never the model's. The place's number comes from the
    // server (get_safe_room_status); without it, "your local emergency number". Its card comes with the answer.
    if (health) return ok(await healthEmergencyTurn(session, recorder, correlationId, leftMs));
    const answer = await agent.ask(question, { correlationId, deadlineMs: leftMs });
    if (!answer.ok) {
      if (answer.error.code === 'agent_timeout') {
        // The cancelled run may still be finishing: the next turn gets a fresh agent and session.
        ready = undefined;
        void session.close?.().catch((e: unknown) => {
          deps.log?.(logLine(toolError('agent_unavailable', 'A timed-out MCP session could not be closed.'), e instanceof Error ? e.name : typeof e, { correlationId }));
        });
      }
      return answer;
    }
    const cards = recorder.cards();
    const status = recorder.status();
    const reply = replyText(answer.value.text);
    // A warning, not an internal error: the person still gets an answer, cut, or a sentence for an empty one.
    if (reply.cut || reply.empty) {
      const line = logLine(toolError('output_schema_violation', 'The model reply did not fit a TurnReply.'), reply.cut ? 'ReplyTooLong' : 'ReplyEmpty', { correlationId });
      deps.log?.({ ...line, level: 'warn' });
    }
    return ok({ text: reply.text, ...(status === undefined ? {} : { status }), ...(cards.length === 0 ? {} : { cards: [...cards] }) });
  };

  // One turn at a time per home (review of #121): the recorder and the conversation history belong to
  // the running turn, so a second question waits for the first instead of resetting its cards.
  let queue: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  return {
    ask(question, correlationId) {
      // A health worry is never "busy" (review of #523): with the queue full it gets the fixed answer at once, with the
      // local emergency number, rather than waiting or a refusal.
      if (inFlight >= MAX_TURNS_PER_HOME && isHealthEmergency(question)) return Promise.resolve(ok(healthEmergencyWithoutRoom(correlationId)));
      if (inFlight >= MAX_TURNS_PER_HOME) {
        const busy = toolError('turn_in_progress', 'Wait for the answer to the previous question, then ask again.', { retryAfterMs: deps.config.turnDeadlineMs });
        deps.log?.(logLine(busy, 'TurnQueueFull', { correlationId }));
        return Promise.resolve(err(busy));
      }
      inFlight++;
      const arrivedAt = now();
      const run = queue.then(() => turn(question, correlationId, arrivedAt)).finally(() => {
        inFlight--;
      });
      queue = run.catch(() => undefined); // a failed turn never blocks the next one
      return run;
    },
  };
}
