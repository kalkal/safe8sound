import { SandboxHomeIdSchema } from '@cold-reserve/contracts';

/** A visitor's sandbox id never reaches a log line (#134, #139): it is said as "sandbox". */
export const isSandbox = (homeId: string): boolean => SandboxHomeIdSchema.safeParse(homeId).success;
export const homeDetail = (homeId: string | undefined): { home?: 'sandbox' } => (homeId !== undefined && isSandbox(homeId) ? { home: 'sandbox' } : {});
