import { Alarm } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/** Every alarm under `scope` notifies the stage's alarm topic (security review, 22 Oct); none without a topic. */
export function notifyAlarms(scope: Construct, topic: ITopic | undefined): void {
  if (topic === undefined) return;
  for (const alarm of scope.node.findAll().filter((c): c is Alarm => c instanceof Alarm)) alarm.addAlarmAction(new SnsAction(topic));
}
