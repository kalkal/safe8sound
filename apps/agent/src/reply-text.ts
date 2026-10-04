// The model's text as a TurnReply may carry it (#202): sim-api refuses a reply over 600 characters, or an empty
// one, as output_schema_violation, and the person then gets no answer at all. The answer is kept whole when it
// fits; otherwise it is cut at the last full sentence, or at a word with an ellipsis. The caller logs a cut or an
// empty text.

export const MAX_REPLY_CHARS = 600;
export const EMPTY_REPLY = 'Sorry, I have no answer to that. Please ask again.';

const ELLIPSIS = '…';
/** A word that belongs to the number before it: a cut never leaves "10:00" without its "PM", or 27 without °C. */
const UNIT = /^(AM|PM|°C|°F|%|kWh|kW|Wh|W|h|min)(?![A-Za-z0-9])/;

/** The reply text, and whether it had to be cut or was empty. */
export function replyText(raw: string): { text: string; cut: boolean; empty: boolean } {
  // Some models write their reasoning in <thinking> tags: it is never said to the person.
  const said = raw.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (said.length === 0) return { text: EMPTY_REPLY, cut: false, empty: true };
  if (said.length <= MAX_REPLY_CHARS) return { text: said, cut: false, empty: false };
  const head = said.slice(0, MAX_REPLY_CHARS);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (sentenceEnd > 0) return { text: head.slice(0, sentenceEnd + 1), cut: true, empty: false };
  return { text: `${atWord(said)}${ELLIPSIS}`, cut: true, empty: false };
}

/** The longest start of the text, cut at a space, that leaves room for the ellipsis and splits no number from its unit. */
function atWord(said: string): string {
  const room = MAX_REPLY_CHARS - ELLIPSIS.length;
  let space = said.lastIndexOf(' ', room);
  while (space > 0 && UNIT.test(said.slice(space + 1))) space = said.lastIndexOf(' ', space - 1);
  return space > 0 ? said.slice(0, space) : said.slice(0, room);
}
