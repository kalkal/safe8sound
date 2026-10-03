// A full-screen card is a modal dialog (#206 review): while it shows, everything else on the page is inert, so
// Tab and clicks never reach the Ask box or another card under it.

/** Makes every element off the path from `keep` to <body> inert; the returned function undoes only those. */
export function makeRestInert(keep: Element): () => void {
  const changed: Element[] = [];
  let node: Element = keep;
  while (node.parentElement !== null) {
    const parent: Element = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== node && !sibling.hasAttribute('inert')) {
        sibling.setAttribute('inert', '');
        changed.push(sibling);
      }
    }
    if (parent === parent.ownerDocument.body) break;
    node = parent;
  }
  return () => {
    for (const element of changed) element.removeAttribute('inert');
  };
}
