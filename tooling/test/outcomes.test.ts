import { describe, expect, it } from 'vitest';
import { planRun, sizesFor } from '../src/outcomes.mjs';

const SIZES = { quick: ['a', 'c'], sizes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

describe('the outcome suite runner', () => {
  it('runs every size with none asked, the quick ones with quick, in the order of sizes.json', () => {
    expect(sizesFor([], SIZES)).toEqual({ ok: true, ids: ['a', 'b', 'c'] });
    expect(sizesFor(['quick'], SIZES)).toEqual({ ok: true, ids: ['a', 'c'] });
    expect(sizesFor(['c', 'b', 'c'], SIZES)).toEqual({ ok: true, ids: ['b', 'c'] });
  });

  it('refuses a size that is not in sizes.json, saying which', () => {
    expect(sizesFor(['a', 'zz'], SIZES)).toEqual({ ok: false, unknown: ['zz'] });
  });

  it('greps a journey by its tag, an outcome by its own tag only (O1 never matches O10)', () => {
    expect(planRun(['journey', 'judge', '1904x870'])).toMatchObject({ ok: true, grep: '@journey:judge', golden: false, sizes: ['1904x870'] });
    const o1 = planRun(['outcome', 'O1']);
    expect(o1).toMatchObject({ ok: true, golden: false });
    const grep = new RegExp(o1.ok ? (o1.grep ?? '') : '');
    expect(grep.test('step @outcome:O1')).toBe(true);
    expect(grep.test('step @outcome:O10')).toBe(false);
  });

  it('runs both journeys in one build per size', () => {
    expect(planRun(['journeys', '375x812'])).toMatchObject({ ok: true, grep: '@journey:', golden: false, sizes: ['375x812'] });
  });

  it('runs the golden tests first and every journey for all', () => {
    expect(planRun(['all', 'quick'])).toMatchObject({ ok: true, grep: undefined, golden: true, sizes: ['1904x870', '375x812'] });
  });

  it('refuses an unknown journey, an outcome outside O1-O15 and an unknown command', () => {
    expect(planRun(['journey', 'robot'])).toMatchObject({ ok: false });
    expect(planRun(['outcome', 'O16'])).toMatchObject({ ok: false });
    expect(planRun(['nope'])).toMatchObject({ ok: false });
  });
});
