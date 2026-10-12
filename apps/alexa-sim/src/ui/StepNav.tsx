import { useEffect, useRef } from 'react';
import { STEPS, type Step } from './steps.js';
import { t } from './text.js';

// "Back" always there and the path of the steps (idea 5, after Alexa's backstack and its header's back button): Back
// at the start of the header band, always on screen (disabled with nowhere to go), and one dot per step with the
// current one drawn longer and named, so the place is read in words, not by colour alone.

export interface StepNavProps {
  step: Step;
  onBack: (() => void) | undefined;
  /** Back just disabled itself under the keyboard focus (review of #350): where the focus goes instead. */
  onFocusLost?: () => void;
}

export function StepNav({ step, onBack, onFocusLost }: StepNavProps) {
  const button = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  const disabled = onBack === undefined;
  useEffect(() => {
    if (!disabled || !hadFocus.current) return;
    const active = document.activeElement;
    if (active === button.current || active === document.body || active === null) onFocusLost?.();
    hadFocus.current = false;
  }, [disabled, onFocusLost]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="chip-button back-button"
        disabled={disabled}
        onClick={onBack}
        onFocus={() => {
          hadFocus.current = true;
        }}
        onBlur={(event) => {
          // A blur because the button was disabled has nowhere to go: the flag stays for the effect above.
          if (event.relatedTarget !== null) hadFocus.current = false;
        }}
      >
        <svg className="back-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M15 5 8 12l7 7" />
        </svg>
        {t('nav.back')}
      </button>
      <ol className="step-dots" aria-label={t('steps.list')} data-step={step}>
        {STEPS.map((each) => (
          <li key={each} className="step" {...(each === step ? { 'aria-current': 'step' as const } : {})}>
            <span className="step-dot" aria-hidden="true" />
            <span className={each === step ? 'step-name' : 'visually-hidden'}>{t(`steps.${each}`)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
