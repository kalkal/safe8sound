import type { DataOriginValue } from '@cold-reserve/contracts';
import { t } from './text.js';

/** LIVE / SIMULATED next to every number (plan §11.1): simulated data is never shown as real. */
export function OriginBadge({ origin }: { origin: DataOriginValue }) {
  return (
    <span className="badge" data-origin={origin} data-testid="origin-badge">
      {origin === 'simulated' && <span aria-hidden="true">≈ </span>}
      {t(origin === 'live' ? 'data.live' : 'data.simulatedBadge')}
    </span>
  );
}

/** Option B (owner, 20 Oct): a fixed figure of the scripted mode says it is an example, never a live reading. */
export function OfflineExampleBadge() {
  return (
    <span className="badge" data-origin="simulated" data-testid="offline-example">
      {t('data.offlineExample')}
    </span>
  );
}
