// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale, type Locale } from '@cold-reserve/i18n';
import type { GetPreferencesOutput, SetScenarioInput } from '@cold-reserve/contracts';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';
import { scriptedDemoSettings, type DemoSettingsView } from '../../src/ui/demo-settings.js';
import type { LimitChange, LimitSave } from '../../src/ui/limits.js';
import { SettingsPage, settingsAnnounce, useSettingsPage } from '../../src/ui/SettingsPage.js';
import { useSettingsModel } from '../../src/ui/settings-model.js';

// The person's own settings inside the Echo (#432 S5): "Settings" in the screen's menu opens a page of the screen, like
// "Show my home"; Back, Escape or "Hide settings" closes it. Who we protect (read only), then the language, the safe
// room, the temperatures and limits and the units. One model for every view: the Echo's page and Ana's phone show the
// same data and the same unsaved draft.

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

const TITLE = "Safe-8-Sound settings · Leo's home";

interface HarnessProps {
  settings: DemoSettingsView | undefined;
  onChange?: (change: SetScenarioInput) => Promise<boolean>;
  locale?: Locale;
  onLocale?: (locale: Locale) => void;
  limits?: GetPreferencesOutput;
  onLimit?: (change: LimitChange) => Promise<LimitSave>;
  onFocusLost?: () => void;
  /** A second view of the same model, as Ana's phone shows it. */
  twice?: boolean;
}

function Harness({ settings, onChange = () => Promise.resolve(true), locale = 'en-US', onLocale = vi.fn(), limits, onLimit, onFocusLost, twice = false }: HarnessProps) {
  const model = useSettingsModel({ settings, onChange, limits, onLimit });
  const page = useSettingsPage({ model, render: () => <SettingsPage model={model} locale={locale} onLocale={onLocale} />, ...(onFocusLost === undefined ? {} : { onFocusLost }) });
  return (
    <>
      {page.button}
      {page.view}
      {twice && (
        <>
          <div data-testid="phone">
            <SettingsPage model={model} locale={locale} onLocale={onLocale} announce={settingsAnnounce('phone', { echoOpen: page.isOpen, phoneModal: false })} />
          </div>
          {/* What a new answer does on the Echo: close its page, open or not. */}
          <button type="button" onClick={page.close}>
            a new answer
          </button>
        </>
      )}
    </>
  );
}

const setup = (props: Partial<HarnessProps> = {}) => {
  const onChange = vi.fn(() => Promise.resolve(true));
  const onLocale = vi.fn();
  render(<Harness settings={scriptedDemoSettings()} onChange={onChange} onLocale={onLocale} {...props} />);
  return { onChange, onLocale, button: screen.getByRole('button', { name: 'Settings' }) };
};

describe('the settings page', () => {
  it('"Settings" opens the page of the screen, titled for Leo\'s home; the button then says "Hide settings"', () => {
    const { button } = setup();
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('region', { name: TITLE })).toBeTruthy();
    expect(button.textContent).toBe('Hide settings');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // Never a modal: the page is one of the screen's pages, not a dialog over it.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says who we protect, read only, with their drawn avatars and no health data', () => {
    const { button } = setup();
    fireEvent.click(button);
    const protect = screen.getByRole('region', { name: 'Who we protect' });
    const people = within(protect).getAllByRole('listitem');
    expect(people.map((p) => p.textContent)).toEqual(['Leo, 82, grandfather', 'Ana, daughter, gets the alerts on her phone']);
    expect(people.map((p) => p.querySelector('svg')?.getAttribute('data-avatar'))).toEqual(['older-man', 'adult-woman']);
    expect(within(protect).queryByRole('button')).toBeNull();
    expect(within(protect).queryByRole('textbox')).toBeNull();
    expect(protect.textContent).not.toMatch(/condition|medical|diagnos|medicine/i);
  });

  it('with no one at risk at home, "Who we protect" shows the small house and says so, never Leo (owner, 20 Oct)', () => {
    render(<Harness settings={{ ...scriptedDemoSettings(), household: 'no-one-at-risk' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const people = within(screen.getByRole('region', { name: 'Who we protect' })).getAllByRole('listitem');
    expect(people.map((p) => p.textContent)).toEqual(['No one at risk at home: the home keeps everyone comfortable', 'Ana, daughter, gets the alerts on her phone']);
    expect(people.map((p) => p.querySelector('svg')?.getAttribute('data-avatar'))).toEqual(['home', 'adult-woman']);
    // The line beside it says the same: the house is not read out twice.
    expect(people[0]?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('holds only the person\'s own settings, never a demo control, and says where they are saved', () => {
    const { button } = setup();
    fireEvent.click(button);
    for (const name of ['Language', 'Temperature units']) expect(screen.getByRole('radiogroup', { name })).toBeTruthy();
    for (const name of ['Scenario', 'Weather', 'Place', 'Who is at home']) expect(screen.queryByRole('radiogroup', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart the day' })).toBeNull();
    expect(screen.getByRole('region', { name: TITLE }).textContent).toContain("Saved for Leo's home · used on the Echo and on Ana's phone");
  });

  it('Escape closes the page and the focus goes back to its button', () => {
    const { button } = setup();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('region', { name: TITLE }), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  // The owner, 21 Oct, on the dev site: after saving she could not find how to leave the page. A Back always at the top
  // left of the page, first in it (like the Echo Show's back arrow), closes it as Escape does: one close, the focus back
  // where the page was opened from.
  it('"Back" at the top left closes the page like Escape, and the focus goes back to its button', () => {
    const { button } = setup();
    fireEvent.click(button);
    const page = screen.getByRole('region', { name: TITLE });
    const back = screen.getByRole('button', { name: 'Back' });
    // First in the page: before its title, so it is the first thing reached and seen.
    expect(back.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(back.getAttribute('data-testid')).toBe('settings-back');
    fireEvent.click(back);
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('"Back" in Italian is "Indietro"', () => {
    setLocale('it-IT');
    render(<Harness settings={scriptedDemoSettings()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Impostazioni' }));
    expect(screen.getByRole('button', { name: 'Indietro' })).toBeTruthy();
    setLocale('en-US');
  });

  it('Escape with the button gone (it sits in the closed menu) hands the focus back to the caller', () => {
    const onFocusLost = vi.fn();
    function MenuClosed() {
      const model = useSettingsModel({ settings: scriptedDemoSettings(), onChange: () => Promise.resolve(true), limits: undefined, onLimit: undefined });
      const page = useSettingsPage({ model, render: () => <SettingsPage model={model} locale="en-US" onLocale={vi.fn()} />, onFocusLost });
      return (
        <>
          <button type="button" onClick={page.open}>
            open
          </button>
          {page.view}
        </>
      );
    }
    render(<MenuClosed />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.keyDown(screen.getByRole('region', { name: TITLE }), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    expect(onFocusLost).toHaveBeenCalledTimes(1);
  });

  it('said or tapped, opening the page runs onShow (the home closes: one page of the screen at a time)', () => {
    const onShow = vi.fn();
    function Said() {
      const model = useSettingsModel({ settings: scriptedDemoSettings(), onChange: () => Promise.resolve(true), limits: undefined, onLimit: undefined });
      const page = useSettingsPage({ model, render: () => <SettingsPage model={model} locale="en-US" onLocale={vi.fn()} />, onShow });
      return (
        <>
          {page.button}
          <button type="button" onClick={page.open}>
            say settings
          </button>
          {page.view}
        </>
      );
    }
    render(<Said />);
    fireEvent.click(screen.getByRole('button', { name: 'say settings' }));
    expect(screen.getByRole('region', { name: TITLE })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide settings' }));
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it('a unit is chosen at once, saved, and the page says so; a failed save says so too', async () => {
    let finish: (saved: boolean) => void = () => undefined;
    const onChange = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    setup({ onChange });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('radio', { name: /°F/ }));
    expect(onChange).toHaveBeenCalledWith({ units: 'F' });
    expect(screen.getByRole('radio', { name: /°F/ }).closest('label')?.textContent).toContain('Saving…');
    finish(false);
    await waitFor(() => {
      expect(screen.getByTestId('settings-applied').textContent).toBe("That change wasn't saved. Try again.");
    });
  });

  it('#263: the language is a row of its own, English by default; choosing Italiano changes only the page', () => {
    const { button, onLocale, onChange } = setup();
    fireEvent.click(button);
    const language = screen.getByRole('radiogroup', { name: 'Language' });
    expect(within(language).getByRole('radio', { name: /English/ })).toHaveProperty('checked', true);
    fireEvent.click(within(language).getByRole('radio', { name: /Italiano/ }));
    expect(onLocale).toHaveBeenCalledWith('it-IT');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('#263: in Italian the page has its Italian title and says honestly that the answers are still in English', () => {
    setLocale('it-IT');
    render(<Harness settings={scriptedDemoSettings()} locale="it-IT" />);
    fireEvent.click(screen.getByRole('button', { name: 'Impostazioni' }));
    expect(screen.getByRole('region', { name: 'Impostazioni di Safe-8-Sound · casa di Leo' })).toBeTruthy();
    expect(screen.getByTestId('language-note').textContent).toBe('Alexa risponde ancora in inglese: per ora l’italiano vale per le scritte della pagina e delle card.');
  });

  it('in English there is no such note', () => {
    const { button } = setup();
    fireEvent.click(button);
    expect(screen.queryByTestId('language-note')).toBeNull();
  });

  it('#284: without demo settings (not a sandbox, or not read yet) the page still has who we protect and the Language row', () => {
    render(<Harness settings={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('region', { name: 'Who we protect' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Temperature units' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Scenario' })).toBeNull();
  });
});

// #402: the "Temperatures and limits" section. Values and bounds come from the preferences and their hard limits.
describe('Temperatures and limits section', () => {
  const view = (() => {
    const card = SCRIPT_FIXTURES.preferences();
    if (card.tool !== 'get_preferences') throw new Error('fixture');
    return card.result;
  })();
  const open = (units: 'C' | 'F' = 'C', extra: Partial<HarnessProps> = {}) => {
    const onLimit = vi.fn<(change: LimitChange) => Promise<LimitSave>>(() => Promise.resolve('saved'));
    const onChange = vi.fn(() => Promise.resolve(true));
    render(<Harness settings={{ ...scriptedDemoSettings(), units }} onChange={onChange} limits={view} onLimit={onLimit} {...extra} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return { onLimit, onChange, section: screen.getAllByRole('region', { name: 'Temperatures and limits' })[0] as HTMLElement };
  };

  it('holds the safe room, the comfort, the maximum, the units and the night limits with their sources', () => {
    const { section } = open();
    expect(within(section).getByRole('radiogroup', { name: 'Safe room' })).toBeTruthy();
    expect(within(section).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('25 °C');
    expect(within(section).getByRole('radiogroup', { name: 'Temperature units' })).toBeTruthy();
    expect(section.textContent).toContain('Adult, 22:00–07:00: at most 26 °C');
    expect(section.textContent).toContain('With an older or frail person: at most 24 °C');
    expect(section.textContent).toContain('CIBSE TM59');
  });

  it('#422: names the safe room choices by the names get_preferences gives, by their readable id otherwise', () => {
    const rooms = view.preferences.roomPriority.map((id) => ({ id, name: id === 'bedroom-1' ? "Leo's room" : 'Room ' + id }));
    render(<Harness settings={scriptedDemoSettings()} limits={{ ...view, rooms }} onLimit={vi.fn<(change: LimitChange) => Promise<LimitSave>>(() => Promise.resolve('saved'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const safeRoom = screen.getByRole('radiogroup', { name: 'Safe room' });
    expect(within(safeRoom).getByRole('radio', { name: /Leo's room/ })).toHaveProperty('checked', true);
    expect(safeRoom.textContent).not.toContain('Bedroom 1');
  });

  it('the steps and choices change a draft; Save sends it as one write, and the draft is gone once saved', async () => {
    const { section, onLimit } = open();
    const other = view.preferences.roomPriority[1] as string;
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    fireEvent.click(within(within(section).getByRole('radiogroup', { name: 'Safe room' })).getAllByRole('radio')[1] as HTMLElement);
    fireEvent.click(within(section).getByRole('checkbox', { name: /night limit to every plan/ }));
    expect(onLimit).not.toHaveBeenCalled();
    expect(within(section).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('24.5 °C');
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onLimit).toHaveBeenCalledTimes(1);
    });
    expect(onLimit).toHaveBeenCalledWith({
      comfortC: { cooling: 24.5 },
      safeRoomId: other,
      roomPriority: [other, ...view.preferences.roomPriority.filter((id) => id !== other)],
      safety: { stricterNightLimit: true },
    });
    // Nothing left to save: the button says Saved ✓ and a second press sends nothing.
    await waitFor(() => {
      expect(within(section).getByRole('button', { name: 'Saved ✓' }).getAttribute('aria-disabled')).toBe('true');
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Saved ✓' }));
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it('unsaved changes say so, and are still there when the page is closed and opened again', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Lower: Comfort temperature' }));
    expect(screen.getByText('Not saved yet: press Save.')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('region', { name: TITLE }), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Not saved yet: press Save.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('24.5 °C');
  });

  it("one model for every view: a step made on Ana's phone shows on the Echo's page at once", () => {
    open('C', { twice: true });
    const phone = screen.getByTestId('phone');
    fireEvent.click(within(phone).getByRole('button', { name: 'Lower: Comfort temperature' }));
    const echo = screen.getAllByRole('region', { name: TITLE }).find((r) => !phone.contains(r)) as HTMLElement;
    expect(within(echo).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('24.5 °C');
    // Two views at once are two radio groups each: a choice on one never unchecks the other's (one name per view).
    const checked = (root: HTMLElement) => within(within(root).getByRole('radiogroup', { name: 'Safe room' })).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked).length;
    expect([checked(echo), checked(phone)]).toEqual([1, 1]);
  });

  it("two views open at once announce once: the Echo's page speaks, Ana's shows the same lines silently; alone, Ana's speaks", () => {
    render(<Harness settings={scriptedDemoSettings()} limits={view} twice />);
    const phone = screen.getByTestId('phone');
    // The lines the page itself makes live (an <output> is a status by its tag: its aria-live is checked below).
    const live = () => [...document.querySelectorAll<HTMLElement>('[data-testid="settings-page"] [role="status"], [data-testid="settings-page"] [role="alert"]')];
    // The Echo's page closed: only Ana's page has live lines.
    expect(live().every((el) => phone.contains(el))).toBe(true);
    expect(live()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    // Both open: still one of each line, now on the Echo's page; Ana's page shows the same text without a live role.
    expect(live()).toHaveLength(3);
    expect(live().some((el) => phone.contains(el))).toBe(false);
    expect(within(phone).getByTestId('limit-refusal').getAttribute('role')).toBeNull();
    expect(phone.querySelectorAll('output[aria-live="polite"]')).toHaveLength(0);
    expect(phone.querySelectorAll('output[aria-live="off"]').length).toBeGreaterThan(0);
  });

  it('exactly one view announces while both are on screen, also under the phone\'s modal sheet (the Echo\'s page is inert there)', () => {
    for (const echoOpen of [true, false])
      for (const phoneModal of [true, false]) {
        const echo = echoOpen && settingsAnnounce('echo', { echoOpen, phoneModal });
        const phone = settingsAnnounce('phone', { echoOpen, phoneModal });
        expect([echoOpen, phoneModal, Number(echo) + Number(phone)]).toEqual([echoOpen, phoneModal, 1]);
      }
    expect(settingsAnnounce('phone', { echoOpen: true, phoneModal: true })).toBe(true);
    expect(settingsAnnounce('echo', { echoOpen: true, phoneModal: true })).toBe(false);
  });

  it("closing the Echo's page when it is already closed leaves Ana's page as it is (a refusal stays said)", () => {
    const onLimit = vi.fn<(change: LimitChange) => Promise<LimitSave>>(() => Promise.resolve('saved'));
    render(<Harness settings={scriptedDemoSettings()} limits={view} onLimit={onLimit} twice />);
    const phone = screen.getByTestId('phone');
    fireEvent.click(within(phone).getByRole('button', { name: 'Raise: Cap with an older or frail person' }));
    expect(within(phone).getByTestId('limit-refusal').textContent).toContain('can only be made stricter');
    fireEvent.click(screen.getByRole('button', { name: 'a new answer' }));
    expect(within(phone).getByTestId('limit-refusal').textContent).toContain('can only be made stricter');
  });

  it('after a save the button says "Saved ✓", off, on the open page; the next change makes it Save again (owner, 20 Oct, A)', async () => {
    const { section, onLimit } = open();
    onLimit.mockImplementationOnce(() => Promise.resolve<LimitSave>('saved'));
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    const saved = await within(section).findByRole('button', { name: 'Saved ✓' });
    expect(saved.getAttribute('aria-disabled')).toBe('true');
    // The status line says it too, for a screen reader (review of #469).
    expect(screen.getAllByText('Saved.').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: TITLE })).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    expect(within(section).getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('false');
    // A step back to the saved value leaves nothing to save: Saved ✓ again (review of #469).
    fireEvent.click(within(section).getByRole('button', { name: 'Raise: Comfort temperature' }));
    expect(within(section).getByRole('button', { name: 'Saved ✓' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('says "Salvato ✓" in Italian', async () => {
    setLocale('it-IT');
    render(<Harness settings={scriptedDemoSettings()} locale="it-IT" limits={view} onLimit={() => Promise.resolve<LimitSave>('saved')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Impostazioni' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abbassa: Temperatura di comfort' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect(await screen.findByRole('button', { name: 'Salvato ✓' })).toBeTruthy();
  });

  it('says honestly, in a small Winter block right after the temperatures and limits, that winter mode comes next (owner, 20 Oct)', () => {
    const { section } = open();
    const winter = screen.getAllByRole('region', { name: 'Winter' })[0] as HTMLElement;
    expect(within(winter).getByTestId('winter-note').textContent).toBe("Winter mode (keeping warm when it's cold): coming next. This demo covers summer heat and storms.");
    // Its own block, after the limits, with a decorative snowflake and no switch.
    expect(section.contains(winter)).toBe(false);
    expect(section.compareDocumentPosition(winter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(winter.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(winter).queryByRole('checkbox')).toBeNull();
  });

  it('says it in Italian too', () => {
    setLocale('it-IT');
    render(<Harness settings={scriptedDemoSettings()} locale="it-IT" limits={view} />);
    fireEvent.click(screen.getByRole('button', { name: 'Impostazioni' }));
    const winter = screen.getByRole('region', { name: 'Inverno' });
    expect(within(winter).getByTestId('winter-note').textContent).toBe('Modalità inverno (tenere al caldo quando fa freddo): in arrivo. Questa demo copre il caldo estivo e le tempeste.');
  });

  it('Save is blocked while it saves: a second press sends nothing', async () => {
    const { section, onLimit } = open();
    onLimit.mockImplementationOnce(() => new Promise<LimitSave>(() => undefined));
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    const save = within(section).getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(onLimit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(save.getAttribute('aria-disabled')).toBe('true');
    });
  });

  it('a step against the rule sends nothing and says why; Save with no change sends nothing', () => {
    const { section, onLimit } = open();
    fireEvent.click(within(section).getByRole('button', { name: 'Raise: Cap with an older or frail person' }));
    expect(screen.getByTestId('limit-refusal').textContent).toContain('can only be made stricter');
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(onLimit).not.toHaveBeenCalled();
  });

  it('the daily limit of the demo is said as it is, not as "try again"', async () => {
    const { section, onLimit } = open();
    onLimit.mockResolvedValueOnce('rate_limited');
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByText(/limited number of changes per day/)).toBeTruthy();
    });
  });

  it('shows every value in °F when chosen, and the units choice stays here', () => {
    const { section, onChange } = open('F');
    expect(within(section).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('77 °F');
    expect(section.textContent).toContain('at most 78.8 °F');
    fireEvent.click(within(section).getByRole('radio', { name: '°C' }));
    expect(onChange).toHaveBeenCalledWith({ units: 'C' });
  });
});
