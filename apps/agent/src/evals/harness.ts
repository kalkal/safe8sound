import type { ErrorCode } from '@cold-reserve/contracts';
import type { ColdReserveAgent } from '../agent.js';
import type { EvalSuite } from './cases.js';
import { scoreCase, type CaseScore } from './metrics.js';

export interface CaseResult extends Partial<CaseScore> {
  readonly id: string;
  readonly category: string;
  readonly pass: boolean;
  readonly toolCalls: readonly string[];
  readonly text: string;
  /** Set when the turn failed (e.g. agent_unavailable): the case counts as failed. */
  readonly error?: ErrorCode;
}

export interface EvalReport {
  readonly version: string;
  readonly threshold: number;
  readonly passRate: number;
  readonly passed: boolean;
  readonly results: readonly CaseResult[];
}

/**
 * Runs every utterance on a fresh agent (no shared history), then scores it. The agent factory
 * decides the model: the fake one now, Bedrock after Spike S2 (run by hand, never in CI).
 */
export async function runEvals(suite: EvalSuite, makeAgent: () => ColdReserveAgent): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of suite.cases) {
    const turn = await makeAgent().ask(c.utterance);
    if (!turn.ok) {
      results.push({ id: c.id, category: c.category, pass: false, toolCalls: [], text: '', error: turn.error.code });
      continue;
    }
    const score = scoreCase(c, turn.value);
    results.push({ id: c.id, category: c.category, ...score, toolCalls: turn.value.toolCalls, text: turn.value.text });
  }
  const passRate = results.filter((r) => r.pass).length / results.length;
  return { version: suite.version, threshold: suite.threshold, passRate, passed: passRate >= suite.threshold, results };
}
