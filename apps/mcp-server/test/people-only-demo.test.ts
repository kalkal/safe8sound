import { LogEntrySchema } from '@cold-reserve/contracts';
import { demoProfile } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/handler.js';
import { homeProfileOf } from '../src/startup-log.js';

// R17: the demo's fictional names ("Leo") reach the model in the tool texts, so a profile of the real home that
// carries them is refused as a value, with one error line that names the field and never a name or a sandbox id.

const SANDBOX = 'demo#0123456789abcdef';

function capture() {
  const lines: LogEntry[] = [];
  return { lines, logger: { log: (e: LogEntry) => lines.push(e) } };
}

describe('a home profile with names, as a value', () => {
  it('refuses the real home with names: invalid_config, one structured line, no names in it', () => {
    const { lines, logger } = capture();
    const result = homeProfileOf({ ...demoProfile(), homeId: 'home' }, logger, 'corr-r17');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_config');
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(LogEntrySchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({ level: 'error', code: 'invalid_config', correlationId: 'corr-r17', details: { event: 'home_profile_refused', home: 'real', fields: ['people'] } });
    const text = JSON.stringify(line);
    for (const p of demoProfile().people ?? []) expect(text).not.toContain(p.name);
  });

  it('accepts the demo home and a visitor sandbox with their names, and logs nothing', () => {
    const { lines, logger } = capture();
    const demo = homeProfileOf(demoProfile(), logger, 'corr-r17');
    const sandbox = homeProfileOf({ ...demoProfile(), homeId: SANDBOX }, logger, 'corr-r17');
    expect(demo.ok && demo.value.people?.length).toBeGreaterThan(0);
    expect(sandbox.ok && sandbox.value.people?.length).toBeGreaterThan(0);
    expect(lines).toEqual([]);
  });

  it('accepts the real home without names', () => {
    const { lines, logger } = capture();
    const result = homeProfileOf({ ...demoProfile(), homeId: 'home', people: undefined }, logger, 'corr-r17');
    expect(result.ok && result.value.people).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('says a refused sandbox profile as "sandbox", never its id', () => {
    const { lines, logger } = capture();
    const result = homeProfileOf({ ...demoProfile(), homeId: SANDBOX, epsBaseLoadW: -1 }, logger, 'corr-r17');
    expect(result.ok).toBe(false);
    expect(lines[0]?.details).toMatchObject({ home: 'sandbox', fields: ['epsBaseLoadW'] });
    expect(JSON.stringify(lines)).not.toContain(SANDBOX);
  });
});
