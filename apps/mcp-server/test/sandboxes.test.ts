import { HomeIdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createSandboxes } from '../src/sandboxes.js';

const HOUR = 3_600_000;
const home = (n: number) => HomeIdSchema.parse(`demo#${n.toString(16).padStart(16, '0')}`);

function setup(maxNewPerDay = 2) {
  let now = Date.UTC(2026, 9, 1, 12);
  const created: string[] = [];
  const sandboxes = createSandboxes({
    clock: { now: () => now },
    ttlMs: 24 * HOUR,
    maxNewPerDay,
    create: (h) => {
      created.push(h);
      return { home: h };
    },
  });
  return { sandboxes, created, advance: (ms: number) => (now += ms) };
}

describe('sandbox homes (#101): created on first use, 24 h TTL, a daily cap', () => {
  it('creates a sandbox once and reuses it', () => {
    const { sandboxes, created } = setup();
    expect(sandboxes.admit(home(1))).toMatchObject({ ok: true, value: { home: home(1) } });
    sandboxes.admit(home(1));
    expect(sandboxes.get(home(1))).toEqual({ home: home(1) });
    expect(created).toEqual([home(1)]);
  });

  it('refuses a new sandbox past the daily cap with demo_quota_exceeded until midnight UTC, existing ones still work', () => {
    const { sandboxes } = setup(2);
    sandboxes.admit(home(1));
    sandboxes.admit(home(2));
    expect(sandboxes.admit(home(3))).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryAfterMs: 12 * HOUR } });
    expect(sandboxes.get(home(3))).toBeUndefined();
    expect(sandboxes.admit(home(1)).ok).toBe(true);
  });

  it('forgets a sandbox 24 h after its last use', () => {
    const { sandboxes, created, advance } = setup(10);
    sandboxes.admit(home(1));
    advance(23 * HOUR);
    sandboxes.admit(home(1)); // used again: the 24 h start over
    advance(23 * HOUR);
    expect(sandboxes.get(home(1))).toBeDefined();
    advance(2 * HOUR);
    expect(sandboxes.get(home(1))).toBeUndefined();
    sandboxes.admit(home(1));
    expect(created).toEqual([home(1), home(1)]);
  });

  it('starts a new daily count after midnight UTC', () => {
    const { sandboxes, advance } = setup(1);
    sandboxes.admit(home(1));
    expect(sandboxes.admit(home(2)).ok).toBe(false);
    advance(12 * HOUR);
    expect(sandboxes.admit(home(2)).ok).toBe(true);
  });
});

describe('sandbox refresh (C2, #222): a sandbox follows its stored settings', () => {
  it('replaces a live sandbox with what refresh builds, and leaves it when refresh keeps it', async () => {
    let now = Date.UTC(2026, 9, 4, 9);
    let version = 1;
    const sandboxes = createSandboxes({
      clock: { now: () => now },
      ttlMs: 24 * HOUR,
      maxNewPerDay: 5,
      create: (h) => ({ home: h, version: 0 }),
      refresh: (_h, current) => Promise.resolve(current.version === version ? current : { ...current, version }),
    });
    sandboxes.admit(home(1));
    await sandboxes.refresh(home(1), 'c-1');
    expect(sandboxes.get(home(1))).toEqual({ home: home(1), version: 1 });
    const same = sandboxes.get(home(1));
    await sandboxes.refresh(home(1), 'c-2');
    expect(sandboxes.get(home(1))).toBe(same);
    version = 2;
    now += HOUR;
    await sandboxes.refresh(home(1), 'c-3');
    expect(sandboxes.get(home(1))).toEqual({ home: home(1), version: 2 });
  });

  it('does nothing for a sandbox that is not live, and nothing without a refresh', async () => {
    const { sandboxes } = setup();
    await expect(sandboxes.refresh(home(9), 'c-1')).resolves.toBeUndefined();
    expect(sandboxes.get(home(9))).toBeUndefined();
  });
});
