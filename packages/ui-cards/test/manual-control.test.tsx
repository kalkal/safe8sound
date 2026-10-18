// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualControlCard } from '../src/ManualControlCard.js';

afterEach(cleanup);

const instructions = [
  { roomId: 'bedroom-1', text: 'Bedroom: dry at 26 °C' },
  { roomId: 'living', text: 'Living room: off' },
];

describe('ManualControlCard (plan §11.6: the splits are set by hand)', () => {
  it('says why it cannot set the splits itself, and what to set in each room', () => {
    render(<ManualControlCard instructions={instructions} reason="cloud_unreachable" />);
    expect(screen.getByRole('region', { name: 'Manual control' })).toBeTruthy();
    expect(screen.getByText("The air-conditioner cloud is not answering, so I can't set the splits myself. Please set these with the remote:")).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Set by hand' }).textContent).toContain('Bedroom: dry at 26 °C');
  });

  it('on the real home during the hackathon, explains that it only gives advice', () => {
    render(<ManualControlCard instructions={instructions} reason="read_only" />);
    expect(screen.getByText('This home is read-only for now, so nothing is changed automatically. Please set these with the remote:')).toBeTruthy();
  });

  it('marks a room done by touch, with a large target, and counts what is left', () => {
    render(<ManualControlCard instructions={instructions} reason="cloud_unreachable" />);
    const done = screen.getByRole('button', { name: 'Done: Bedroom: dry at 26 °C' });
    expect(done.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(done);
    expect(done.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('1 of 2 rooms done.');
    expect(screen.queryByText(/say "done"/)).toBeNull();
  });

  it('says when every room is done', () => {
    render(<ManualControlCard instructions={instructions} reason="cloud_unreachable" />);
    for (const button of screen.getAllByRole('button', { name: /^Done:/ })) fireEvent.click(button);
    expect(screen.getByRole('status').textContent).toBe('All rooms are set. Thank you.');
  });

  it('shows the data badge like the other cards (#193): SIMULATED on simulated data, none when no origin is given', () => {
    const { unmount } = render(<ManualControlCard instructions={instructions} reason="cloud_unreachable" origin="simulated" />);
    expect(screen.getByTestId('origin-badge').textContent).toBe('≈ SIMULATED');
    unmount();
    render(<ManualControlCard instructions={instructions} reason="cloud_unreachable" />);
    expect(screen.queryByTestId('origin-badge')).toBeNull();
  });
});
