import { PreferencesSchema, type Preferences, type ReserveOutlook, type SafetyHardLimits } from '@cold-reserve/contracts';
import { CATALOGS, type MessageKey } from '@cold-reserve/i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CardShell } from './CardShell.js';
import { formatHours, t } from './text.js';

const SETPOINT_STEP_C = 0.5;
/** PreferencesSchema: `familyContacts` holds at most 3 (plan §11.2 p.14). */
const MAX_CONTACTS = 3;

export interface PreferencesCardProps {
  preferences: Preferences;
  limits: SafetyHardLimits;
  /** Room names from the home profile; ids only reach the card from the preferences. */
  rooms: ReadonlyArray<{ id: string; name: string }>;
  outlook?: ReserveOutlook;
  onSave?: (preferences: Preferences) => void;
}

/** Roles are free words in the contract: known ones come from the catalog, others are shown as written. */
function roleLabel(role: string): string {
  const key = `role.${role}`;
  if (key in CATALOGS['en-US']) return t(key as MessageKey);
  const words = role.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The first contract problem, said in words (no codes, error-handling §3). */
function saveProblem(path: ReadonlyArray<PropertyKey>): string {
  const field = path.join('.');
  if (field === 'comfortC.cooling') return t('prefs.error.comfortAboveMax');
  if (field === 'comfortC.heating') return t('prefs.error.comfortBelowMin');
  if (field.startsWith('roomPriority')) return t('prefs.error.priority');
  return t('prefs.error.other');
}

/** A button that stays focusable when unavailable (`aria-disabled`), so keyboard focus is never dropped. */
function StepButton(props: { label: string; unavailable: boolean; onPress: () => void; buttonRef?: (el: HTMLButtonElement | null) => void; children: ReactNode }) {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      className="card-expand"
      aria-label={props.label}
      aria-disabled={props.unavailable}
      onClick={() => {
        if (!props.unavailable) props.onPress();
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * Preferences in one screen (plan §11.2 p.14): setpoint with − / +, safe room, room priority, reserve
 * read-only in hours, contacts by role and channel only (never names or handles). Cooling season for now.
 */
export function PreferencesCard({ preferences, limits, rooms, outlook, onSave }: PreferencesCardProps) {
  const [draft, setDraft] = useState(preferences);
  // A plain number while editing: the contract schema brands it again on save.
  const [cooling, setCooling] = useState<number>(preferences.comfortC.cooling);
  const [problem, setProblem] = useState<string | null>(null);
  const contactsId = useId();
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);

  // React moves the row in the DOM after a reorder, which drops focus: put it back on the same button.
  useEffect(() => {
    const key = pendingFocus.current;
    pendingFocus.current = null;
    if (key !== null) moveButtons.current.get(key)?.focus();
  });

  const nameOf = (id: string) => rooms.find((r) => r.id === id)?.name ?? id;
  // Upper bound: the safety maximum. Lower bound: the heating comfort (cooling below it makes no sense);
  // the contract has no separate floor for the cooling setpoint.
  const coolingMax: number = draft.safety.cooling.maxC;
  const coolingMin: number = draft.comfortC.heating;
  const move = (index: number, direction: 'up' | 'down') => {
    const order = [...draft.roomPriority];
    const [room] = order.splice(index, 1);
    if (room === undefined) return;
    order.splice(direction === 'up' ? index - 1 : index + 1, 0, room);
    pendingFocus.current = `${room}:${direction}`;
    setDraft({ ...draft, roomPriority: order });
  };
  const save = () => {
    const parsed = PreferencesSchema.safeParse({ ...draft, comfortC: { ...draft.comfortC, cooling } });
    setProblem(parsed.success ? null : t('prefs.invalid', { reason: saveProblem(parsed.error.issues[0]?.path ?? []) }));
    if (parsed.success) onSave?.(parsed.data);
  };

  return (
    <CardShell title={t('prefs.title')} {...(outlook !== undefined && { origin: outlook.origin.energy })}>
      <fieldset className="prefs-group">
        <legend className="eyebrow">{t('prefs.comfort')}</legend>
        <div className="stepper">
          <StepButton
            label={t('prefs.cooler')}
            unavailable={cooling <= coolingMin}
            onPress={() => {
              setCooling(Math.max(coolingMin, cooling - SETPOINT_STEP_C));
            }}
          >
            −
          </StepButton>
          <span className="stepper-value" data-testid="comfort-value" aria-live="polite">
            {t('prefs.degrees', { value: String(cooling) })}
          </span>
          <StepButton
            label={t('prefs.warmer')}
            unavailable={cooling >= coolingMax}
            onPress={() => {
              setCooling(Math.min(coolingMax, cooling + SETPOINT_STEP_C));
            }}
          >
            +
          </StepButton>
        </div>
        <p className="muted">
          {t('prefs.safetyMax', { value: String(draft.safety.cooling.maxC), min: String(limits.cooling.maxC.min), max: String(limits.cooling.maxC.max) })}
        </p>
      </fieldset>

      <fieldset className="prefs-group">
        <legend className="eyebrow">{t('prefs.safeRoom')}</legend>
        {rooms.map((room) => (
          <label key={room.id} className="choice">
            <input
              type="radio"
              name="safe-room"
              checked={draft.safeRoomId === room.id}
              onChange={() => {
                setDraft({ ...draft, safeRoomId: room.id, roomPriority: [room.id, ...draft.roomPriority.filter((id) => id !== room.id)] });
              }}
            />
            {room.name}
          </label>
        ))}
      </fieldset>

      <div className="prefs-group">
        <p className="eyebrow">{t('prefs.priority')}</p>
        <p className="muted">{t('prefs.priorityHint')}</p>
        <ol className="priority" aria-label={t('prefs.priority')}>
          {draft.roomPriority.map((id, i) => (
            <li key={id} className="priority-row">
              <span data-testid="room-name">{nameOf(id)}</span>
              {i > 0 && (
                <span className="priority-moves">
                  {(['up', 'down'] as const).map((direction) => (
                    <StepButton
                      key={direction}
                      label={t(direction === 'up' ? 'prefs.moveUp' : 'prefs.moveDown', { room: nameOf(id) })}
                      unavailable={direction === 'up' ? i === 1 : i === draft.roomPriority.length - 1}
                      buttonRef={(el) => {
                        if (el === null) moveButtons.current.delete(`${id}:${direction}`);
                        else moveButtons.current.set(`${id}:${direction}`, el);
                      }}
                      onPress={() => {
                        move(i, direction);
                      }}
                    >
                      {direction === 'up' ? '↑' : '↓'}
                    </StepButton>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      {outlook !== undefined && <p className="muted">{t('prefs.reserve', { hours: formatHours(outlook.reserveHoursAtEssential) })}</p>}

      <p className="eyebrow" id={contactsId}>
        {t('prefs.contacts', { count: String(draft.familyContacts.length), max: String(MAX_CONTACTS) })}
      </p>
      <ul className="contacts" aria-labelledby={contactsId}>
        {draft.familyContacts.map((c, i) => (
          <li key={i}>{`${roleLabel(c.role)} · ${t(`prefs.channel.${c.channel}`)}`}</li>
        ))}
      </ul>

      {problem !== null && <p role="alert">{problem}</p>}
      <div className="plan-actions">
        <button type="button" className="button-primary" onClick={save}>
          {t('prefs.save')}
        </button>
        <p className="muted">{t('prefs.voiceHint')}</p>
      </div>
    </CardShell>
  );
}
