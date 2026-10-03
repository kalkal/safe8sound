import { PhoneReplyOutputSchema, type HomeId } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { familyReply, safeRoomStatus, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { world } from './support.js';

// Queue item 3 (approved in #24): the family phone answers with a closed set of replies. The role comes from
// the phone's token, never from the body; the reply is recorded on the storm session by role, never by name.

const phoneCtx = (w: ReturnType<typeof world>, role = 'daughter') => ({ ...w.ctx, clientId: role });

describe('a reply from the family phone', () => {
  it('"I\'m on my way" during the storm is recorded by role, and the safe-room status says it', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await familyReply(w.deps, { reply: 'on_my_way' }, phoneCtx(w));
    if (!out.ok) throw new Error(out.error.message);
    expect(PhoneReplyOutputSchema.parse(out.value)).toEqual({ recorded: { role: 'daughter', reply: 'on_my_way', at: new Date(w.clock.now()).toISOString() } });
    const status = await safeRoomStatus(w.deps, w.ctx);
    expect(status.ok && status.value.lastCheckIn).toMatchObject({ role: 'daughter', reply: 'on_my_way' });
    expect(JSON.stringify(out.value)).not.toMatch(/Giulia|phone-/);
  });

  it('"Check status" also returns the safe room as the phone shows it, roles only', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await familyReply(w.deps, { reply: 'check_status' }, phoneCtx(w));
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.status).toMatchObject({ safeRoomId: 'bedroom-1', occupantRoles: ['grandpa'], stormPhase: 'active' });
    expect(JSON.stringify(out.value)).not.toMatch(/Giulia|phone-/);
  });

  it('"Check status" when the safe room cannot be read: an error, and nothing recorded, so a retry is not refused as too soon', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    // The reply's own reading works; the status read that follows does not.
    const base = w.deps.homes;
    let reads = 0;
    const failing = {
      ...w.deps,
      homes: (h: HomeId) => {
        const home = base(h);
        reads++;
        return home && (reads === 1 ? home : { ...home, forecast: () => ({ ...home.forecast(), hourly: [] }) });
      },
    };
    const out = await familyReply(failing, { reply: 'check_status' }, phoneCtx(w));
    expect(!out.ok && out.error.code).toBe('forecast_unavailable');
    const session = await w.store.getLatestStormSession();
    expect(session.ok && session.value?.familyReplies).toBeUndefined();
    expect((await familyReply(w.deps, { reply: 'check_status' }, phoneCtx(w))).ok).toBe(true);
  });

  it('a second reply from the same role within minReplySeconds is refused with when to retry; it is not recorded', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    await familyReply(w.deps, { reply: 'on_my_way' }, phoneCtx(w));
    w.clock.set(w.clock.now() + 10_000);
    const again = await familyReply(w.deps, { reply: 'check_status' }, phoneCtx(w));
    expect(!again.ok && again.error).toMatchObject({ code: 'family_reply_rate_limited', category: 'rate_limited', retryAfterMs: 20_000 });
    const session = await w.store.getLatestStormSession();
    expect(session.ok && session.value?.familyReplies).toHaveLength(1);
    w.clock.set(w.clock.now() + 20_000);
    expect((await familyReply(w.deps, { reply: 'check_status' }, phoneCtx(w))).ok).toBe(true);
  });

  it('a phone whose role is not a registered contact is refused', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await familyReply(w.deps, { reply: 'on_my_way' }, phoneCtx(w, 'neighbor'));
    expect(!out.ok && out.error.code).toBe('recipient_not_registered');
  });

  it('without a storm in progress there is nothing to reply to', async () => {
    const w = world(1);
    const out = await familyReply(w.deps, { reply: 'on_my_way' }, phoneCtx(w));
    expect(!out.ok && out.error).toMatchObject({ code: 'invalid_input', details: { field: 'reply' } });
  });

  it('keeps the last 50 replies of the session', async () => {
    const w = world(4);
    const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!started.ok) throw new Error(started.error.message);
    const old = Array.from({ length: 50 }, (_, i) => ({ role: 'daughter', reply: 'check_status' as const, at: new Date(w.clock.now() - (60 - i) * 60_000).toISOString() }));
    await w.store.saveStormSession({ ...started.value.session, familyReplies: old });
    const out = await familyReply(w.deps, { reply: 'on_my_way' }, phoneCtx(w));
    expect(out.ok).toBe(true);
    const session = await w.store.getLatestStormSession();
    const replies = (session.ok && session.value?.familyReplies) || [];
    expect(replies).toHaveLength(50);
    expect(replies.at(-1)?.reply).toBe('on_my_way');
  });

  it('logs one info line with the role and the reply, never a name (correlation id, sandbox rule)', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    await familyReply(w.deps, { reply: 'on_my_way' }, phoneCtx(w));
    const line = w.logs.find((l) => l.details?.['event'] === 'family_reply_recorded');
    expect(line).toMatchObject({ level: 'info', correlationId: 'test-correlation', details: { role: 'daughter', reply: 'on_my_way' } });
    expect(JSON.stringify(w.logs)).not.toMatch(/Giulia|phone-daughter/);
  });
});
