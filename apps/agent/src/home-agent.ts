import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type TurnReply } from '@cold-reserve/contracts';
import type { Model } from '@strands-agents/sdk';
import { createAgent, type ColdReserveAgent } from './agent.js';
import type { AgentConfig } from './config.js';
import { classifyFailure } from './failure.js';
import { logLine, type AgentLogEntry } from './log.js';
import type { HomeAgent } from './invocations.js';
import { createTurnRecorder, mcpToolset, type McpSession, type TurnRecorder } from './mcp-tools.js';
import { replyText } from './reply-text.js';

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

  const turn = async (question: string, correlationId: string, arrivedAt: number): Promise<Result<TurnReply, ErrorEnvelope>> => {
    // Waited too long for the previous turn: answer now, and keep the agent (this turn never started).
    const deadlineMs = deps.config.turnDeadlineMs - (now() - arrivedAt);
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
      return err(failure.error);
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
      return err(timeout);
    }
    const { agent, recorder, session } = built;
    // Waiting for the previous turn AND opening the session both count: the model gets only what is
    // left (review of #139). Nothing started yet, so the agent and its session are kept.
    const leftMs = deps.config.turnDeadlineMs - (now() - arrivedAt);
    if (leftMs <= 0) {
      const timeout = toolError('agent_timeout', 'The assistant took too long to answer. Try again in a moment.');
      deps.log?.(logLine(timeout, 'TurnDeadline', { correlationId }));
      return err(timeout);
    }
    recorder.reset(correlationId);
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
