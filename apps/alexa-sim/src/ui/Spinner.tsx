// A small "working" mark next to a status line or a button's words (15 Oct, a tap that seemed to do nothing).
// Decorative: the status line or the button's aria-busy says it. With reduced motion it stands still.
export function Spinner() {
  return <span className="spinner" aria-hidden="true" data-testid="spinner" />;
}
