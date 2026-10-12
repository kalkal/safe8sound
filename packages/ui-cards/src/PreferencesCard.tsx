import { SetPreferencesInputSchema, formatTemp, toDisplayTemp, type DataOriginValue, type GetPreferencesOutput, type ReserveOutlook, type SetPreferencesInput } from '@cold-reserve/contracts';
import { CATALOGS, type MessageKey } from '@cold-reserve/i18n';
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CardShell } from './CardShell.js';
import { getTempUnit } from './temp-unit.js';
import { formatHours, t } from './text.js';

const SETPOINT_STEP_C = 0.5;
/** PublicPreferencesSchema: at most 3 contacts (plan §11.2 p.14). */
const MAX_CONTACTS = 3;

export interface PreferencesCardProps {
  /** Exactly the get_preferences result: contacts by role and channel, never names or handles. */
  view: GetPreferencesOutput;
  /** Room names from the home profile, when the host has them; otherwise the ids are shown readably. */
  rooms?: ReadonlyArray<{ id: string; name: string }>;
  outlook?: ReserveOutlook;
  /** Origin of the home's data, when the host knows it; else the reserve outlook's. */
  origin?: DataOriginValue;
  /** Receives a confirmed set_preferences input with only what changed. */
  onSave?: (change: SetPreferencesInput) => void;
}

/** "bedroom-1" → "Bedroom 1": ids and roles are plain words in the contract. */
function readableId(id: string): string {
  const words = id.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Roles are free words in the contract: known ones come from the catalog, others are shown as written. */
function roleLabel(role: string): string {
  const key = `role.${role}`;
  return key in CATALOGS['en-US'] ? t(key as MessageKey) : readableId(role);
}

type Draft = GetPreferencesOutput['preferences'];

/** The rules the tool will check, said in words before sending (no codes, error-handling §3). */
function saveProblem(draft: Draft, cooling: number): string | null {
  if (cooling > draft.safety.cooling.maxC) return t('prefs.error.comfortAboveMax');
  if (draft.roomPriority[0] !== draft.safeRoomId || new Set(draft.roomPriority).size !== draft.roomPriority.length) return t('prefs.error.priority');
  return null;
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

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
export function PreferencesCard({ view, rooms, outlook, origin, onSave }: PreferencesCardProps) {
  const { preferences, hardLimits: limits } = view;
  const [draft, setDraft] = useState<Draft>(preferences);
  // A plain number while editing: the contract schema brands it again on save.
  const [cooling, setCooling] = useState<number>(preferences.comfortC.cooling);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contactsId = useId();
  const badge = origin ?? outlook?.origin.energy;
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);

  // React moves the row in the DOM after a reorder, which drops focus: put it back on the same button.
  useEffect(() => {
    const key = pendingFocus.current;
    pendingFocus.current = null;
    if (key !== null) moveButtons.current.get(key)?.focus();
  });

  const roomList = rooms ?? preferences.roomPriority.map((id) => ({ id, name: readableId(id) }));
  const nameOf = (id: string) => roomList.find((r) => r.id === id)?.name ?? readableId(id);
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
    const reason = saveProblem(draft, cooling);
    setProblem(reason === null ? null : t('prefs.invalid', { reason }));
    if (reason !== null) return;
    const change = {
      ...(cooling !== preferences.comfortC.cooling && { comfortC: { cooling } }),
      ...(draft.safeRoomId !== preferences.safeRoomId && { safeRoomId: draft.safeRoomId }),
      ...(!sameOrder(draft.roomPriority, preferences.roomPriority) && { roomPriority: draft.roomPriority }),
    };
    setNotice(Object.keys(change).length === 0 ? t('prefs.nothingToSave') : null);
    if (Object.keys(change).length > 0) onSave?.(SetPreferencesInputSchema.parse({ ...change, confirmed: true }));
  };

  return (
    <CardShell
      title={t('prefs.title')}
      {...(badge !== undefined && { origin: badge })}
      // Pages instead of scrolling (owner, 10 Oct): comfort, the safe room, the order, the contacts; Save stays.
      pages={[
        <Fragment key="comfort">
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
                {t('prefs.degrees', { value: formatTemp(cooling, getTempUnit()) })}
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
              {/* °F everywhere (owner decision, 9 Oct): shown in the chosen unit; the steps stay half a degree Celsius. */}
              {t('prefs.safetyMax', {
                value: formatTemp(draft.safety.cooling.maxC, getTempUnit()),
                min: String(toDisplayTemp(limits.cooling.maxC.min, getTempUnit())),
                max: formatTemp(limits.cooling.maxC.max, getTempUnit()),
              })}
            </p>
          </fieldset>
        </Fragment>,
        <Fragment key="safe-room">
          <fieldset className="prefs-group">
            <legend className="eyebrow">{t('prefs.safeRoom')}</legend>
            {roomList.map((room) => (
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
        </Fragment>,
        <Fragment key="order">
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
        </Fragment>,
        // Their own page (owner, 12 Oct): with the order they were too tall for an Echo frame, shrunk to a thumbnail.
        <Fragment key="contacts">
          {outlook !== undefined && <p className="muted">{t('prefs.reserve', { hours: formatHours(outlook.reserveHoursAtEssential) })}</p>}

          <p className="eyebrow" id={contactsId}>
            {t('prefs.contacts', { count: String(draft.contacts.length), max: String(MAX_CONTACTS) })}
          </p>
          <ul className="contacts" aria-labelledby={contactsId}>
            {draft.contacts.map((c, i) => (
              <li key={i}>{`${roleLabel(c.role)} · ${t(`prefs.channel.${c.channel}`)}`}</li>
            ))}
          </ul>
        </Fragment>,
      ]}
    >
      {problem !== null && <p role="alert">{problem}</p>}
      {notice !== null && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      <div className="plan-actions">
        {onSave !== undefined && (
          <button type="button" className="button-primary" onClick={save}>
            {t('prefs.save')}
          </button>
        )}
        <p className="muted">{t('prefs.voiceHint')}</p>
      </div>
    </CardShell>
  );
}
