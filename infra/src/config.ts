import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

export const StageNameSchema = z.enum(['dev', 'demo']);
export type StageName = z.infer<typeof StageNameSchema>;

export const InfraConfigSchema = z.strictObject({
  /** AWS region, e.g. us-east-1. Never hard-coded in stacks. */
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  stages: z.array(StageNameSchema).min(1),
});
export type InfraConfig = z.infer<typeof InfraConfigSchema>;

/** Reads the `cold-reserve:*` keys of the CDK context (cdk.json or `-c key=value`). */
export function loadInfraConfig(context: (key: string) => unknown): Result<InfraConfig, ErrorEnvelope> {
  const parsed = InfraConfigSchema.safeParse({ region: context('cold-reserve:region'), stages: context('cold-reserve:stages') });
  if (parsed.success) return ok(parsed.data);
  return err(
    toolError('invalid_config', 'The CDK context has no valid cold-reserve:region or cold-reserve:stages.', {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    }),
  );
}
