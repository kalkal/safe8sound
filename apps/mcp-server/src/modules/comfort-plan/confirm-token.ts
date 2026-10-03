import { createHash, randomBytes } from 'node:crypto';
import type { Plan } from '@cold-reserve/contracts';

// The token of the second yes to a last-resort plan (#160): 192 random bits, given once to the model, stored
// only as its SHA-256 with the hash of the plan the person heard. Neither ever reaches a log.

export const newLastResortToken = (): string => `lr_${randomBytes(24).toString('base64url')}`;

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The hash of what the person heard: the plan as proposed, whatever its status since. */
export const planHash = (plan: Plan): string => sha256Hex(JSON.stringify({ ...plan, status: 'proposed' }));
