import { Component, type ReactNode } from 'react';
import { log } from './card-log.js';
import { t } from '../text.js';

/** A card that throws shows a calm message, never a blank frame (error-handling §3). */
export class CardErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    log({ level: 'error', code: 'unexpected_error', error, details: { step: 'render' } });
  }

  override render(): ReactNode {
    return this.state.failed ? <p role="alert">{t('card.failed')}</p> : this.props.children;
  }
}
