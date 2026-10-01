import { err, ok, type ErrorEnvelope, type HomeId, type Result, type TurnReply } from '@cold-reserve/contracts';
import type { Model } from '@strands-agents/sdk';
import { createAgent, type ColdReserveAgent } from './agent.js';
import type { AgentConfig } from './config.js';
import { classifyFailure } from './failure.js';
import { logLine, type AgentLogEntry } from './log.js';
import type { HomeAgent } from './invocations.js';
import { createTurnRecorder, mcpToolset, type McpSession } from './mcp-tools.js';

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
}): HomeAgent {
  const recorder = createTurnRecorder();
  let ready: Promise<ColdReserveAgent> | undefined;

  const start = async () => {
    const tools = await mcpToolset(await deps.connect(deps.home), recorder);
    return createAgent({ config: deps.config, model: deps.model, tools, ...(deps.log ? { log: deps.log } : {}) });
  };

  const turn = async (question: string, correlationId: string): Promise<Result<TurnReply, ErrorEnvelope>> => {
    let agent: ColdReserveAgent;
    try {
      agent = await (ready ??= start());
    } catch (e) {
      ready = undefined; // the next turn tries to connect again
      const failure = classifyFailure(e);
      if (failure.kind === 'bug') throw failure.error;
      deps.log?.(logLine(failure.error, e instanceof Error ? e.name : typeof e, { correlationId }));
      return err(failure.error);
    }
    recorder.reset(correlationId);
    const answer = await agent.ask(question, { correlationId });
    if (!answer.ok) return answer;
    const cards = recorder.cards();
    const status = recorder.status();
    return ok({ text: answer.value.text, ...(status === undefined ? {} : { status }), ...(cards.length === 0 ? {} : { cards: [...cards] }) });
  };

  // One turn at a time per home (review of #121): the recorder and the conversation history belong to
  // the running turn, so a second question waits for the first instead of resetting its cards.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ask(question, correlationId) {
      const run = queue.then(() => turn(question, correlationId));
      queue = run.catch(() => undefined); // a failed turn never blocks the next one
      return run;
    },
  };
}
