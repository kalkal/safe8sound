// The model's text as a TurnReply may carry it (#202): sim-api refuses a reply over 600 characters, or an empty
// one, as output_schema_violation, and the person then gets no answer at all. The answer is kept whole when it
// fits; otherwise it is cut at the last full sentence, and the caller logs that the model wrote too much.

export const MAX_REPLY_CHARS = 600;
export const EMPTY_REPLY = 'Sorry, I have no answer to that. Please ask again.';

/** The reply text and whether it had to be cut. */
export function replyText(raw: string): { text: string; cut: boolean } {
  // Some models write their reasoning in <thinking> tags: it is never said to the person.
  const said = raw.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (said.length === 0) return { text: EMPTY_REPLY, cut: false };
  if (said.length <= MAX_REPLY_CHARS) return { text: said, cut: false };
  const head = said.slice(0, MAX_REPLY_CHARS);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (sentenceEnd > 0) return { text: head.slice(0, sentenceEnd + 1), cut: true };
  const space = head.lastIndexOf(' ');
  return { text: space > 0 ? head.slice(0, space) : head, cut: true };
}
