import { describe, expect, it, vi } from 'vitest';
import { matchScreenCommand, pagerSayable, runScreenCommand, type ScreenCommand } from '../../src/ui/screen-commands.js';

const commands = (): ScreenCommand[] => [
  { id: 'next_answer', phrases: ['Next answer', 'Next'], run: vi.fn() },
  { id: 'show_home', phrases: ['Show my home'], run: vi.fn() },
  { id: 'light_theme', phrases: ['Light theme'], run: vi.fn() },
];

describe('matchScreenCommand (every button sayable)', () => {
  it('matches a whole label, ignoring case, punctuation, "Alexa" and "please"', () => {
    const list = commands();
    expect(matchScreenCommand('Show my home', list)?.id).toBe('show_home');
    expect(matchScreenCommand('show my home.', list)?.id).toBe('show_home');
    expect(matchScreenCommand('Alexa, next', list)?.id).toBe('next_answer');
    expect(matchScreenCommand('Next answer, please', list)?.id).toBe('next_answer');
    expect(matchScreenCommand('LIGHT THEME!', list)?.id).toBe('light_theme');
  });

  it('leaves questions to the agent: a label inside a longer question is not a command', () => {
    const list = commands();
    expect(matchScreenCommand('What comes next?', list)).toBeUndefined();
    expect(matchScreenCommand('Can you show my home battery?', list)).toBeUndefined();
    expect(matchScreenCommand('', list)).toBeUndefined();
    expect(matchScreenCommand('  ?! ', list)).toBeUndefined();
  });

  it('runs the command and logs it with the turn id and the command id only, never the words said', () => {
    const list = commands();
    const log = vi.fn();
    expect(runScreenCommand('Alexa, show my home please', 'turn-1', list, log)).toBe(true);
    expect(list[1]?.run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ level: 'info', code: 'screen_command', correlationId: 'turn-1', details: { command: 'show_home' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('my home');
  });

  it('a question is not run nor logged', () => {
    const list = commands();
    const log = vi.fn();
    expect(runScreenCommand('What comes next?', 'turn-2', list, log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    for (const command of list) expect(command.run).not.toHaveBeenCalled();
  });

  it('the answer pager is sayable while listening too (a spoken "Next answer" is no turn), not while a turn runs, failed, or the home is open', () => {
    const on = { thinking: false, failed: false, pageOpen: false, hasAnswers: true };
    expect(pagerSayable(on)).toBe(true);
    expect(pagerSayable({ ...on, thinking: true })).toBe(false);
    expect(pagerSayable({ ...on, failed: true })).toBe(false);
    expect(pagerSayable({ ...on, pageOpen: true })).toBe(false);
    expect(pagerSayable({ ...on, hasAnswers: false })).toBe(false);
  });

  it('reads other languages: letters beyond ASCII are kept', () => {
    const list: ScreenCommand[] = [{ id: 'light_theme', phrases: ['Tema chiaro'], run: vi.fn() }, { id: 'next_answer', phrases: ['Più avanti'], run: vi.fn() }];
    expect(matchScreenCommand('tema chiaro', list)?.id).toBe('light_theme');
    expect(matchScreenCommand('più avanti', list)?.id).toBe('next_answer');
  });
});
