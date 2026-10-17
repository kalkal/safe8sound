import { WARMUP_EVENT } from '@cold-reserve/core';
import { Duration } from 'aws-cdk-lib';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/** Present only on a stage whose warm-up is switched on (config `cold-reserve:warmup`). */
export interface WarmupSchedule {
  readonly rateMinutes: number;
}

/**
 * The scheduled warm-up of one function (#407): a rule in the function's own stack, so switching it off removes
 * the rule and its permission on the next deploy, with no cross-stack export left behind. The target adds the
 * only grant: `lambda:InvokeFunction` for events.amazonaws.com, limited to this rule's ARN. A missed ping is
 * not retried: the next one comes a few minutes later.
 */
export function addWarmup(scope: Construct, fn: IFunction, schedule: WarmupSchedule): Rule {
  return new Rule(scope, 'Warmup', {
    description: `Keeps the function warm during the judging window (#407): a fixed event every ${String(schedule.rateMinutes)} min.`,
    schedule: Schedule.rate(Duration.minutes(schedule.rateMinutes)),
    targets: [new LambdaFunction(fn, { event: RuleTargetInput.fromObject(WARMUP_EVENT), retryAttempts: 0 })],
  });
}
