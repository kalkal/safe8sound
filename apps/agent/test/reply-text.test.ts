import { describe, expect, it } from 'vitest';
import { EMPTY_REPLY, MAX_REPLY_CHARS, replyText } from '../src/reply-text.js';

describe('replyText: the model text as a TurnReply may carry it (#202)', () => {
  it('keeps a text that fits, whitespace tidied', () => {
    expect(replyText('  The plan holds.\n Shall I apply it? ')).toEqual({ text: 'The plan holds. Shall I apply it?', cut: false, empty: false });
  });

  it('drops thinking blocks, even an unclosed one', () => {
    expect(replyText('<thinking>22 °C was refused.</thinking> The plan holds.').text).toBe('The plan holds.');
    expect(replyText('The plan holds. <thinking>and then').text).toBe('The plan holds.');
  });

  it('says an empty text, and flags it', () => {
    expect(replyText(' <thinking>x</thinking> ')).toEqual({ text: EMPTY_REPLY, cut: false, empty: true });
  });

  it('cuts a long text at the last full sentence', () => {
    const r = replyText(`The plan holds. ${'It keeps the room cool. '.repeat(40)}`);
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(r.text.endsWith('cool.')).toBe(true);
  });

  it('with no sentence end, cuts at a word and adds an ellipsis', () => {
    const r = replyText(`${'word '.repeat(200)}end`);
    expect(r.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(r.text).toMatch(/word…$/);
  });

  it('never splits a number from its unit or a time from AM/PM', () => {
    for (const unit of ['PM', 'AM', '°C', '%', 'kW', 'kWh', 'W', 'h']) {
      // The cut falls exactly between the number and its unit.
      const head = 'a '.repeat(Math.floor((MAX_REPLY_CHARS - 8) / 2));
      const text = `${head}10:00 ${unit} and more words after it`;
      const r = replyText(text);
      expect(r.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
      expect(r.text.endsWith('10:00…')).toBe(false);
      expect(r.text).toMatch(/a…$|10:00 \S+…$/);
    }
  });

  it('a single word longer than the limit is cut at the limit, with the ellipsis', () => {
    const r = replyText('x'.repeat(700));
    expect(r.text).toHaveLength(MAX_REPLY_CHARS);
    expect(r.text.endsWith('…')).toBe(true);
  });
});
