import { Component, type ReactNode } from 'react';
import { log } from '../log.js';
import { t } from './text.js';

/** One per surface and per card: a broken part never blanks the whole screen (error-handling §3). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    log({ level: 'error', code: 'unexpected_error', error, details: { step: 'render' } });
  }

  override render(): ReactNode {
    return this.state.failed ? <p role="alert">{t('surface.failed')}</p> : this.props.children;
  }
}
