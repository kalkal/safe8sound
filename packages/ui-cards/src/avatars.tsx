// The drawn avatars of the household (#432 S3): Leo, the older man the home protects, on the Echo's idle tile and in
// "Who we protect"; Ana, his daughter, in the header of her phone. Hand-drawn on a 64 × 64 grid, never a photo of a
// real person. Inline only and class-colored (avatars.css reads the tokens): the CSP blocks <style>, style attributes
// and external images. No ids, so the same avatar can be drawn twice on a page. The avatar sits beside the person's
// name, which says who it is, so screen readers skip it. Kept out of index.ts: the card bundle never carries it.

import { t } from './text.js';

export const AVATAR_KINDS = ['older-man', 'adult-woman', 'home'] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

const DISC = 'M32 0a32 32 0 1 1 0 64a32 32 0 1 1 0-64Z';
// Shoulders that end on the disc's edge, so nothing is drawn outside it.
const SHOULDERS = 'M12 56C13 47 21 43 32 43S51 47 52 56A32 32 0 0 1 12 56Z';

function OlderMan() {
  return (
    <>
      <path d={SHOULDERS} className="avatar-clothes" />
      <path d="M28 43 32 50 36 43" className="avatar-line" />
      <rect x="28" y="36" width="8" height="8" className="avatar-skin" />
      <ellipse cx="21" cy="28" rx="3" ry="3.5" className="avatar-skin" />
      <ellipse cx="43" cy="28" rx="3" ry="3.5" className="avatar-skin" />
      <ellipse cx="32" cy="27" rx="11" ry="13" className="avatar-skin" />
      {/* White hair left on the sides, a wisp on top, the brows and the moustache. */}
      <path d="M20.5 30C18 22 20 15.5 25.5 13.5 23.5 18 23 23 23.5 29Z" className="avatar-hair" />
      <path d="M43.5 30C46 22 44 15.5 38.5 13.5 40.5 18 41 23 40.5 29Z" className="avatar-hair" />
      <path d="M29 14.5C31 12.5 34 12.5 36 14.5 34 14 31 14 29 14.5Z" className="avatar-hair" />
      <path d="M24.5 22.5Q27.5 20.5 30.5 22.5 27.5 21.8 24.5 22.5Z M33.5 22.5Q36.5 20.5 39.5 22.5 36.5 21.8 33.5 22.5Z" className="avatar-hair" />
      <path d="M26.5 33.5Q32 30.5 37.5 33.5 35 35.5 32 34.5 29 35.5 26.5 33.5Z" className="avatar-hair" />
      {/* Round glasses with the eyes behind them, and a smile under the moustache. */}
      <circle cx="27.5" cy="26.5" r="4" className="avatar-line" />
      <circle cx="36.5" cy="26.5" r="4" className="avatar-line" />
      <path d="M31.5 26.5h1 M23.5 26 21.5 25 M40.5 26l2-1" className="avatar-line" />
      <path d="M26.7 26.8a0.8 0.8 0 1 0 1.6 0a0.8 0.8 0 1 0-1.6 0Z M35.7 26.8a0.8 0.8 0 1 0 1.6 0a0.8 0.8 0 1 0-1.6 0Z" className="avatar-line" />
      <path d="M29.5 36.5Q32 38.3 34.5 36.5" className="avatar-line" />
    </>
  );
}

function AdultWoman() {
  return (
    <>
      {/* Shoulder-length hair behind the head. */}
      <path d="M18 30C16 7 48 7 46 30L47 44C41 47 23 47 17 44Z" className="avatar-hair" />
      <path d={SHOULDERS} className="avatar-clothes" />
      <rect x="28" y="36" width="8" height="8" className="avatar-skin" />
      <ellipse cx="32" cy="27" rx="11" ry="13" className="avatar-skin" />
      {/* The fringe swept to one side. */}
      <path d="M20.5 27C19 8 45 7.5 43.5 26 38 18.5 29 18 20.5 27Z" className="avatar-hair" />
      <path d="M26.3 28a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Z M35.3 28a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0Z" className="avatar-line" />
      <path d="M28.5 33.5Q32 36.8 35.5 33.5" className="avatar-line" />
      <path d="M28 46 32 50 36 46" className="avatar-line" />
    </>
  );
}

function Home() {
  return (
    <>
      {/* A small house (owner, 20 Oct, B): no one at risk is at home, so no person is drawn. A chimney, the roof, the
          walls, a door and a window. */}
      <rect x="40" y="17" width="5" height="9" className="avatar-hair" />
      <path d="M13 34 32 16 51 34Z" className="avatar-hair" />
      <path d="M18 32H46V50H18Z" className="avatar-clothes" />
      <rect x="28" y="38" width="8" height="12" className="avatar-skin" />
      <rect x="38" y="36" width="5" height="5" className="avatar-skin" />
      <path d="M13 34 32 16 51 34 M18 50H46" className="avatar-line" />
    </>
  );
}

/**
 * One person's avatar on its disc, sized by the caller through `className`. A person sits beside their name, so
 * screen readers skip it; the house has no name beside it and says what it means ("No one at risk at home").
 */
export function Avatar({ kind, className, decorative = false }: { kind: AvatarKind; className?: string; /** The text beside it says the same: hidden from screen readers even for the house. */ decorative?: boolean }) {
  const label = kind === 'home' && !decorative ? { role: 'img', 'aria-label': t('avatar.home') } : { 'aria-hidden': true };
  return (
    <svg className={className === undefined ? 'avatar' : `avatar ${className}`} data-avatar={kind} viewBox="0 0 64 64" focusable="false" {...label}>
      <path d={DISC} className="avatar-disc" />
      {kind === 'older-man' ? <OlderMan /> : kind === 'home' ? <Home /> : <AdultWoman />}
    </svg>
  );
}
