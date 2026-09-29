import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from './text.js';

/** One per surface and per card: a broken part never blanks the whole screen (error-handling §3). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('surface failed', { code: 'unexpected_error', message: error.message, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    return this.state.failed ? <p role="alert">{t('surface.failed')}</p> : this.props.children;
  }
}
