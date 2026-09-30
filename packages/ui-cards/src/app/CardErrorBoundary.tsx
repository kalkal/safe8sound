import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../text.js';

/** A card that throws shows a calm message, never a blank frame (error-handling §3). */
export class CardErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(JSON.stringify({ level: 'error', component: 'ui-cards', code: 'unexpected_error', message: error.message, stack: info.componentStack?.slice(0, 500) }));
  }

  override render(): ReactNode {
    return this.state.failed ? <p role="alert">{t('card.failed')}</p> : this.props.children;
  }
}
