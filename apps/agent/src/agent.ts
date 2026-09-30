import { Agent, BeforeInvocationEvent, BeforeToolCallEvent, SlidingWindowConversationManager, type Model, type ToolList } from '@strands-agents/sdk';
import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { AgentConfig } from './config.js';
import { classifyFailure } from './failure.js';
import { buildSystemPrompt } from './prompts.js';

export interface AgentTurn {
  readonly text: string;
  readonly stopReason: string;
  /** Tools the agent actually ran this turn, in order. */
  readonly toolCalls: readonly string[];
}

/** One line for the error log: the code and the error type only, never the message (it may hold internals). */
export interface AgentLogEntry {
  readonly code: ErrorEnvelope['code'];
  readonly errorName: string;
  /** HTTP status when the MCP server answered with one (401, 503, ...). */
  readonly httpStatus?: number;
}

export interface ColdReserveAgent {
  /** Expected failures (model or MCP server unreachable) come back as values. */
  ask(question: string): Promise<Result<AgentTurn, ErrorEnvelope>>;
  historyLength(): number;
}

/**
 * The agent on the Strands loop with the caps of the cost rule, all from config:
 * `maxTokens` in the model config, `limits.turns` per invocation, at most `maxToolCalls` tools per
 * turn (a hook cancels the rest), a sliding window of `historyWindowMessages` messages, and an
 * explicit deadline per turn (`turnDeadlineMs`; the MCP client's own default is 60 s).
 */
export function createAgent(deps: { config: AgentConfig; model: Model; tools: ToolList; log?: (entry: AgentLogEntry) => void }): ColdReserveAgent {
  const { config, model } = deps;
  model.updateConfig({ ...model.getConfig(), maxTokens: config.maxTokens });

  const agent = new Agent({
    model,
    tools: deps.tools,
    systemPrompt: buildSystemPrompt(),
    conversationManager: new SlidingWindowConversationManager({ windowSize: config.historyWindowMessages }),
    printer: false,
    retryStrategy: null,
  });

  let ran: string[] = [];
  agent.addHook(BeforeInvocationEvent, () => {
    ran = [];
  });
  agent.addHook(BeforeToolCallEvent, (event) => {
    if (ran.length >= config.maxToolCalls) {
      event.cancel = `Tool call limit of ${String(config.maxToolCalls)} reached for this turn: answer with what you have.`;
      return;
    }
    ran.push(event.toolUse.name);
  });

  return {
    async ask(question) {
      const deadline = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          deadline.abort();
          resolve('timeout');
        }, config.turnDeadlineMs);
      });
      let result;
      try {
        // The signal stops Strands (and in-flight MCP calls); the race returns on time even if a tool ignores it.
        result = await Promise.race([agent.invoke(question, { limits: { turns: config.maxModelTurns }, cancelSignal: deadline.signal }), timedOut]);
      } catch (e) {
        // The model or the MCP server failed: the caller degrades (scripted answer, plan §9.2).
        const failure = classifyFailure(e);
        if (failure.kind === 'bug') throw failure.error;
        deps.log?.({ code: failure.error.code, errorName: e instanceof Error ? e.name : typeof e, ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }) });
        return err(failure.error);
      } finally {
        clearTimeout(timer);
      }
      if (result === 'timeout' || result.stopReason === 'cancelled') {
        deps.log?.({ code: 'agent_timeout', errorName: 'TurnDeadline' });
        return err(toolError('agent_timeout', "The assistant took too long to answer. Try again in a moment."));
      }
      const text = result.lastMessage.content.map((b) => (b.type === 'textBlock' ? b.text : '')).join('');
      return ok({ text, stopReason: result.stopReason, toolCalls: [...ran] });
    },
    historyLength: () => agent.messages.length,
  };
}
