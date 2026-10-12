// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepNav } from '../../src/ui/StepNav.js';

// "Back" always there and the path of the steps (idea 5): a Back button in the header band, and one dot per step
// with the current one marked and named.

afterEach(cleanup);

describe('StepNav', () => {
  it('marks the current step, named in words, among the four', () => {
    render(<StepNav step="plan" onBack={vi.fn()} />);
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(steps.querySelectorAll('li')).toHaveLength(4);
    const current = steps.querySelector('[aria-current="step"]');
    expect(current?.textContent).toBe('Plan');
    expect(steps.textContent).toBe('ConversationHomePlanConfirm');
  });

  it('Back is always shown, says what it is, and goes back when tapped', () => {
    const onBack = vi.fn();
    render(<StepNav step="home" onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Back disabling itself under the focus hands the focus on (review of #350)', () => {
    const onFocusLost = vi.fn();
    const { rerender } = render(<StepNav step="plan" onBack={vi.fn()} onFocusLost={onFocusLost} />);
    screen.getByRole('button', { name: 'Back' }).focus();
    rerender(<StepNav step="conversation" onBack={undefined} onFocusLost={onFocusLost} />);
    expect(onFocusLost).toHaveBeenCalledTimes(1);
  });

  it('Back disabled while the focus is elsewhere: the focus is left alone', () => {
    const onFocusLost = vi.fn();
    const { rerender } = render(<StepNav step="plan" onBack={vi.fn()} onFocusLost={onFocusLost} />);
    rerender(<StepNav step="conversation" onBack={undefined} onFocusLost={onFocusLost} />);
    expect(onFocusLost).not.toHaveBeenCalled();
  });

  it('with nowhere to go back to, Back stays on screen, disabled', () => {
    render(<StepNav step="conversation" onBack={undefined} />);
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true);
  });
});
