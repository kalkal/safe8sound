import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type TurnReply } from '@cold-reserve/contracts';
import type { Model } from '@strands-agents/sdk';
import { createAgent, type ColdReserveAgent } from './agent.js';
import type { AgentConfig } from './config.js';
import { classifyFailure } from './failure.js';
import { logLine, type AgentLogEntry } from './log.js';
import type { HomeAgent } from './invocations.js';
import { createTurnRecorder, mcpToolset, type McpSession, type TurnRecorder } from './mcp-tools.js';

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
  let ready: Promise<{ agent: ColdReserveAgent; recorder: TurnRecorder }> | undefined;

  // Each agent has its own recorder: after a timeout a fresh pair is built, so a Strands run that is
  // still finishing writes into its own recorder, never into the next turn's cards.
  const start = async () => {
    const recorder = createTurnRecorder();
    const tools = await mcpToolset(await deps.connect(deps.home), recorder);
    return { agent: createAgent({ config: deps.config, model: deps.model, tools, ...(deps.log ? { log: deps.log } : {}) }), recorder };
  };

  const turn = async (question: string, correlationId: string, arrivedAt: number): Promise<Result<TurnReply, ErrorEnvelope>> => {
    let built: { agent: ColdReserveAgent; recorder: TurnRecorder };
    try {
      built = await (ready ??= start());
    } catch (e) {
      ready = undefined; // the next turn tries to connect again
      const failure = classifyFailure(e);
      if (failure.kind === 'bug') throw failure.error;
      deps.log?.(logLine(failure.error, e instanceof Error ? e.name : typeof e, { correlationId }));
      return err(failure.error);
    }
    const { agent, recorder } = built;
    recorder.reset(correlationId);
    // The time spent waiting for the previous turn counts toward this one's deadline.
    const answer = await agent.ask(question, { correlationId, deadlineMs: deps.config.turnDeadlineMs - (now() - arrivedAt) });
    if (!answer.ok) {
      if (answer.error.code === 'agent_timeout') ready = undefined; // the cancelled run may still be finishing
      return answer;
    }
    const cards = recorder.cards();
    const status = recorder.status();
    return ok({ text: answer.value.text, ...(status === undefined ? {} : { status }), ...(cards.length === 0 ? {} : { cards: [...cards] }) });
  };

  // One turn at a time per home (review of #121): the recorder and the conversation history belong to
  // the running turn, so a second question waits for the first instead of resetting its cards.
  let queue: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  return {
    ask(question, correlationId) {
      if (inFlight >= MAX_TURNS_PER_HOME) {
        const busy = toolError('demo_quota_exceeded', 'Wait for the answer to the previous question, then ask again.', { retryAfterMs: deps.config.turnDeadlineMs });
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
