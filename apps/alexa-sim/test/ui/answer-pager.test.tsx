// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerPager } from '../../src/ui/AnswerPager.js';

// One answer at a time (owner's choice, 10 Oct): "Previous answer" / "Next answer" and where we are, "2 of 3".
// The labels are what a person would say.

afterEach(cleanup);

describe('AnswerPager', () => {
  it('says where we are and moves both ways', () => {
    const onStep = vi.fn();
    render(<AnswerPager position={{ n: 2, of: 3, hasPrevious: true, hasNext: true }} onStep={onStep} />);
    expect(screen.getByRole('navigation', { name: 'Answers' }).textContent).toContain('Answer 2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next answer' }));
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
  });

  it('in the header band it shows short words, inside its full name (label in name): "Previous" in "Previous answer"', () => {
    render(<AnswerPager position={{ n: 2, of: 3, hasPrevious: true, hasNext: true }} onStep={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous answer' }).textContent).toBe('Previous');
    expect(screen.getByRole('button', { name: 'Next answer' }).textContent).toBe('Next');
  });

  it('at the newest answer, Next is disabled; at the first, Previous is', () => {
    const { rerender } = render(<AnswerPager position={{ n: 3, of: 3, hasPrevious: true, hasNext: false }} onStep={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Next answer' }).hasAttribute('disabled')).toBe(true);
    rerender(<AnswerPager position={{ n: 1, of: 3, hasPrevious: false, hasNext: true }} onStep={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous answer' }).hasAttribute('disabled')).toBe(true);
  });

  it('with a single answer there is nothing to page: no pager at all', () => {
    const { container } = render(<AnswerPager position={{ n: 1, of: 1, hasPrevious: false, hasNext: false }} onStep={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('when the focused button becomes unavailable at an end, focus moves to the other one', () => {
    const onStep = vi.fn();
    const { rerender } = render(<AnswerPager position={{ n: 2, of: 3, hasPrevious: true, hasNext: true }} onStep={onStep} />);
    screen.getByRole('button', { name: 'Next answer' }).focus();
    rerender(<AnswerPager position={{ n: 3, of: 3, hasPrevious: true, hasNext: false }} onStep={onStep} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous answer' }));
  });
});
