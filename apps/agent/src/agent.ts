import { Agent, BeforeInvocationEvent, BeforeToolCallEvent, SlidingWindowConversationManager, type Model, type ToolList } from '@strands-agents/sdk';
import type { AgentConfig } from './config.js';
import { buildSystemPrompt } from './prompts.js';

export interface AgentTurn {
  readonly text: string;
  readonly stopReason: string;
  /** Tools the agent actually ran this turn, in order. */
  readonly toolCalls: readonly string[];
}

export interface ColdReserveAgent {
  ask(question: string): Promise<AgentTurn>;
  historyLength(): number;
}

/**
 * The agent on the Strands loop with the caps of the cost rule, all from config:
 * `maxTokens` in the model config, `limits.turns` per invocation, at most `maxToolCalls` tools per
 * turn (a hook cancels the rest), and a sliding window of `historyWindowMessages` messages.
 */
export function createAgent(deps: { config: AgentConfig; model: Model; tools: ToolList }): ColdReserveAgent {
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
      const result = await agent.invoke(question, { limits: { turns: config.maxModelTurns } });
      const text = result.lastMessage.content.map((b) => (b.type === 'textBlock' ? b.text : '')).join('');
      return { text, stopReason: result.stopReason, toolCalls: [...ran] };
    },
    historyLength: () => agent.messages.length,
  };
}
