import { Component, type ReactNode } from 'react';
import { CardShell, DisplaySlot, DisplayToggle, type DisplayControl } from '../CardShell.js';
import { log } from './card-log.js';
import { t } from '../text.js';

/**
 * "This card could not be shown." as a card with its title row (#356): inline it offers no "Full screen", like any
 * error; a frame already full screen keeps "Back to the conversation" and Escape.
 */
export function CardFailed({ display }: { display?: DisplayControl | undefined }) {
  const toggle = display?.fullscreen === true ? <DisplayToggle display={display} /> : null;
  return (
    <DisplaySlot.Provider value={toggle}>
      <CardShell title={t('card.errorTitle')}>
        <p role="alert">{t('card.failed')}</p>
      </CardShell>
    </DisplaySlot.Provider>
  );
}

/** A card that throws shows a calm message, never a blank frame (error-handling §3). */
export class CardErrorBoundary extends Component<{ children: ReactNode; display?: DisplayControl | undefined }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    log({ level: 'error', code: 'unexpected_error', error, details: { step: 'render' } });
  }

  override render(): ReactNode {
    return this.state.failed ? <CardFailed display={this.props.display} /> : this.props.children;
  }
}
