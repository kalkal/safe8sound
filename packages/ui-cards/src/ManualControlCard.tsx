import type { DataOriginValue, ManualInstruction } from '@cold-reserve/contracts';
import { useState } from 'react';
import { CardShell } from './CardShell.js';
import { t } from './text.js';

export type ManualReason = 'cloud_unreachable' | 'read_only';

/**
 * The manual-control card (plan §11.6): when the split cloud does not answer, or the home is read-only,
 * the card lists what to set by hand in each room. Each room is ticked off by touch (48 px target);
 * nothing here commands the home. Ticking off by voice comes with the voice-parity work.
 * `origin` gives the data badge every other card has (#193); without it, no badge is guessed.
 */
export function ManualControlCard({
  instructions,
  reason,
  origin,
}: {
  instructions: readonly ManualInstruction[];
  reason: ManualReason;
  origin?: DataOriginValue;
}) {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const toggle = (roomId: string) => {
    const next = new Set(done);
    if (next.has(roomId)) next.delete(roomId);
    else next.add(roomId);
    setDone(next);
  };
  const count = instructions.filter((i) => done.has(i.roomId)).length;
  return (
    <CardShell title={t('manual.title')} {...(origin === undefined ? {} : { origin })}>
      <p className="advice">{t(`manual.${reason}`)}</p>
      <ul className="manual-list" aria-label={t('manual.list')}>
        {instructions.map((i) => (
          <li key={i.roomId} data-done={done.has(i.roomId)}>
            <span>{i.text}</span>
            <button
              type="button"
              className="manual-done"
              aria-pressed={done.has(i.roomId)}
              aria-label={t('manual.done', { text: i.text })}
              onClick={() => {
                toggle(i.roomId);
              }}
            >
              {t('manual.doneLabel')}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted" role="status">
        {count === instructions.length ? t('manual.allDone') : t('manual.progress', { done: String(count), total: String(instructions.length) })}
      </p>
    </CardShell>
  );
}
