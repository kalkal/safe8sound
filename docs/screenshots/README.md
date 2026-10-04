# Screenshots

Captures of the simulator and the cards, per theme, for reviews and the submission.

- Never take a page with cards as a full-page capture (`fullPage: true`). Headless Chrome paints sandboxed `ui://` card frames squeezed into a narrow column, even though the layout is correct (#231). Capture the viewport or the element itself (`locator.screenshot()`).
- To check layout, measure it (`boundingBox()`, as in `e2e/cards/plan-that-holds-width.spec.ts`). Do not judge it from a picture.
