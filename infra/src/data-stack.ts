import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

export interface DataStackProps extends StackProps {
  /** demo keeps its data: RETAIN + deletion protection (plan §3.2). */
  readonly retain: boolean;
}

/** The single state table (plan §3.2): PK/SK strings, TTL `ttl`, PITR, on-demand, no GSI. */
export class DataStack extends Stack {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    this.table = new Table(this, 'State', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: props.retain,
      removalPolicy: props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
