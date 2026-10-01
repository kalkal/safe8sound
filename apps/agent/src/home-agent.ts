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

  return {
    async ask(question, correlationId): Promise<Result<TurnReply, ErrorEnvelope>> {
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
      const turn = await agent.ask(question, { correlationId });
      if (!turn.ok) return turn;
      const cards = recorder.cards();
      const status = recorder.status();
      return ok({ text: turn.value.text, ...(status === undefined ? {} : { status }), ...(cards.length === 0 ? {} : { cards: [...cards] }) });
    },
  };
}
