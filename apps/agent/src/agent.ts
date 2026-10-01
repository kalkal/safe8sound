import { AfterToolCallEvent, Agent, BeforeInvocationEvent, BeforeToolCallEvent, SlidingWindowConversationManager, type Model, type ToolList } from '@strands-agents/sdk';
import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { AgentConfig } from './config.js';
import { classifyFailure } from './failure.js';
import { logLine, type AgentLogEntry } from './log.js';
import { buildSystemPrompt } from './prompts.js';

export interface AgentTurn {
  readonly text: string;
  readonly stopReason: string;
  /** Tools the agent actually ran this turn, in order. */
  readonly toolCalls: readonly string[];
  /** Text of each tool result, in order: what the model was told (evals check numbers against it). */
  readonly toolResults: readonly string[];
}

export type { AgentLogEntry } from './log.js';

export interface ColdReserveAgent {
  /** Expected failures (model or MCP server unreachable) come back as values. */
  ask(question: string, opts?: { correlationId?: string }): Promise<Result<AgentTurn, ErrorEnvelope>>;
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
  let results: string[] = [];
  agent.addHook(BeforeInvocationEvent, () => {
    ran = [];
    results = [];
  });
  agent.addHook(AfterToolCallEvent, (event) => {
    results.push(event.result.content.map((c) => (c.type === 'textBlock' ? c.text : c.type === 'jsonBlock' ? JSON.stringify(c.json) : '')).join(''));
  });
  agent.addHook(BeforeToolCallEvent, (event) => {
    if (ran.length >= config.maxToolCalls) {
      event.cancel = `Tool call limit of ${String(config.maxToolCalls)} reached for this turn: answer with what you have.`;
      return;
    }
    ran.push(event.toolUse.name);
  });

  return {
    async ask(question, opts = {}) {
      const { correlationId } = opts;
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
        deps.log?.(logLine(failure.error, e instanceof Error ? e.name : typeof e, { correlationId, httpStatus: failure.httpStatus }));
        return err(failure.error);
      } finally {
        clearTimeout(timer);
      }
      if (result === 'timeout' || result.stopReason === 'cancelled') {
        const timeout = toolError('agent_timeout', 'The assistant took too long to answer. Try again in a moment.');
        deps.log?.(logLine(timeout, 'TurnDeadline', { correlationId }));
        return err(timeout);
      }
      const text = result.lastMessage.content.map((b) => (b.type === 'textBlock' ? b.text : '')).join('');
      return ok({ text, stopReason: result.stopReason, toolCalls: [...ran], toolResults: [...results] });
    },
    historyLength: () => agent.messages.length,
  };
}
