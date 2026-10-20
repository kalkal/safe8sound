import { useId } from 'react';
import { t } from './text.js';

// One choice of the settings or of the judges' demo controls (B1): a radio group of 56 px rows, the choice written with
// a mark, never by colour alone; an option that cannot be chosen says why.

export interface ChipOption {
  value: string;
  label: string;
  /** Written under the label, e.g. "Not available yet". */
  hint?: string;
  disabled?: boolean;
  /** A sample of the scenario's sky (decoration). */
  sky?: string;
}

export function ChipGroup({
  label,
  name,
  options,
  value,
  onPick,
  pending,
  locked = false,
}: {
  label: string;
  name: string;
  options: readonly ChipOption[];
  value: string;
  onPick: (value: string) => void;
  /** The choice just tapped, while it is saved (owner, 18 Oct): shown as chosen at once, saying it is being saved. */
  pending?: string | undefined;
  /** Every choice off (audit of 20 Oct): another change is on its way, or the demo session has ended. */
  locked?: boolean;
}) {
  const labelId = useId();
  const chosen = pending ?? value;
  return (
    <fieldset className="chip-group" role="radiogroup" aria-labelledby={labelId} aria-busy={pending !== undefined}>
      <legend id={labelId}>{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="chip-row" data-checked={o.value === chosen} data-disabled={locked || o.disabled === true}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === chosen}
            disabled={o.disabled === true}
            // Locked, the choice stays focusable (no focus lost to the page) and a tap does nothing (review of #484).
            aria-disabled={locked || undefined}
            onChange={() => {
              if (!locked) onPick(o.value);
            }}
          />
          {o.sky !== undefined && <span className="chip-sky" data-layer={o.sky} aria-hidden="true" />}
          <span className="chip-text">
            <span>{o.label}</span>
            {o.hint !== undefined && <span className="chip-hint">{o.hint}</span>}
            {o.value === pending && <span className="chip-hint">{t('settings.saving')}</span>}
          </span>
          <span className="chip-mark" aria-hidden="true">
            {o.value === chosen ? '✓' : ''}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
