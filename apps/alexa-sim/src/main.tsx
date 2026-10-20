import '@cold-reserve/design-tokens/tokens.css';
import '@cold-reserve/ui-cards/cubes.css';
import '@cold-reserve/ui-cards/avatars.css';
import './app.css';
// The layouts' own styles load between app.css and controls.css, where they always were in the cascade (#432).
import { LAYOUTS } from './surface/registry.js';
// The parts of the screen every layout shows, right after the layouts' own styles, where they always were.
import './ui/screen-parts.css';
import './controls.css';
import { ok, type ErrorEnvelope, type HomeStatus, type Result, type ScenarioId, type SetScenarioInput } from '@cold-reserve/contracts';
import { setLocale } from '@cold-reserve/i18n';
import { cardThemeFor, installTapMarks } from '@cold-reserve/ui-cards';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent, AgentAnswer, AskContext } from './agent/agent.js';
import { buildAgent, buildSession, type DemoSession } from './agent/index.js';
import { parseConfig, type SimConfig } from './config.js';
import { cardDocument } from './host/card-documents.js';
import { CardHostProvider } from './host/card-host.js';
import { Conversation } from './ui/Conversation.js';
import { addLogSink, configErrorEvent, log, logUnhandled } from './log.js';
import { createRemoteLogSink } from './remote-log.js';
import { createInboxPhone } from './phone/inbox-phone.js';
import { createScriptedPhone, type PhoneFeed } from './phone/phone-feed.js';
import { PhonePanel } from './phone/PhonePanel.js';
import { PHONE_BESIDE, PhoneOpener, PhonePeek, PhoneSheet, usePhoneSheet } from './phone/PhoneSheet.js';
import { CardFrame } from './host/CardFrame.js';
import { examplesFor, isGridDown } from './ui/ExampleQuestions.js';
import { fetchHome, homeAfterApply, homeFor, initialHome } from './ui/home.js';
import { useHomePanel } from './ui/HomePanel.js';
import { ReserveClock } from './ui/ReserveClock.js';
import { SimClock } from './ui/SimClock.js';
import { POWER_CUT_QUESTION, clockTime, isPowerCut, planIdOf } from './ui/sim-clock.js';
import { isAppliedPlan } from './ui/steps.js';
import { SHIPPED_PLACES, closedNoticeOf, homeFaceOf, skyOfScenario } from './ui/demo-settings.js';
import { SettingsPage, settingsAnnounce, useSettingsPage } from './ui/SettingsPage.js';
import { useSettingsModel } from './ui/settings-model.js';
import { DemoControlsOpener, DemoControlsPanel, WIDE_CONTROLS, jumpText, useDemoControlsSheet } from './demo-controls/DemoControlsPanel.js';
import { messagesBetween } from './demo-controls/timeline.js';
import { useMediaQuery } from './ui/use-media-query.js';
import { LanguageToggle, nextLocale } from './ui/LanguageToggle.js';
import { readLocale } from './ui/locale-setting.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { skyFor, type Sky } from './ui/sky.js';
import { t } from './ui/text.js';
import { useDemoSettings } from './state/use-demo-settings.js';
import { useLocaleSetting } from './state/use-locale-setting.js';
import { usePreferences } from './state/use-preferences.js';
import { useReserve, useSafeRoom } from './state/use-reserve.js';
import { IdleTiles, ScreenTop, greetingOf, useNotices } from './idle/IdleScreen.js';
import { IconFrame, WeatherOutline } from '@cold-reserve/ui-cards/icons';
import type { ScreenState } from './surface/contract.js';
import { useSimClock } from './state/use-sim-clock.js';
import type { StudioVoice } from './voice/use-voice.js';
import { createRemoteSynthesize, createSpeechTickets } from './voice/studio-voice.js';

logUnhandled(window);
// #263: the language this viewer chose last time, before anything is drawn (English by default).
setLocale(readLocale());
const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');
document.title = t('sim.title');

const config = parseConfig(import.meta.env, window.location.search, import.meta.env.DEV);
// The family phone (surface C, #24): the scripted scene's messages, or the real inbox read through the
// dev server's proxy, which adds the phone token (the browser never holds it).
// The demo session of remote mode (#101): the code is exchanged for a token, never stored.
const session = config.ok ? buildSession(config.value) : undefined;
// Remote mode (#125): the page's warnings and errors also reach sim-api's /v1/log, with the session token, in the
// background; a closing page sends what is waiting.
if (session !== undefined && config.ok && config.value.simApiUrl !== undefined) {
  const remoteLog = createRemoteLogSink({
    url: `${config.value.simApiUrl}/v1/log`,
    token: () => session.token(),
    fetchFn: (url, init) => fetch(url, init),
    schedule: (run, ms) => {
      setTimeout(run, ms);
    },
    now: () => Date.now(),
  });
  addLogSink(remoteLog.sink);
  window.addEventListener('pagehide', remoteLog.flush);
}
// In remote mode (#267) the phone reads the visitor's sandbox inbox from sim-api with that session token.
const remoteInboxUrl = config.ok && config.value.agent === 'remote' && config.value.simApiUrl !== undefined ? `${config.value.simApiUrl}/v1/phone/inbox` : undefined;
const scriptedPhone = config.ok && config.value.phone === 'scripted' && remoteInboxUrl === undefined ? createScriptedPhone() : undefined;
const phone: PhoneFeed =
  scriptedPhone ??
  createInboxPhone({
    fetchFn: (url, init) => fetch(url, init),
    pollMs: config.ok ? config.value.phonePollMs : 5_000,
    log,
    newId: () => crypto.randomUUID(),
    isVisible: () => document.visibilityState !== 'hidden',
    ...(remoteInboxUrl === undefined
      ? {}
      : {
          inboxUrl: remoteInboxUrl,
          authorization: () => {
            const token = session?.token();
            return token === undefined ? undefined : `Bearer ${token}`;
          },
          // A refused token ends the session, as the agent does: the visitor enters the code again, no 401 every poll.
          onAuthFailure: (reason) => session?.invalidate(reason),
        }),
  });
// The studio voice (Polly, F8d #25) needs the demo session: the agent keeps each reply's ticket, the speaker uses it.
const tickets = session === undefined ? undefined : createSpeechTickets();
const agent = config.ok ? buildAgent(config.value, undefined, scriptedPhone, session, tickets) : config;
const studioVoice: StudioVoice | undefined =
  config.ok && session !== undefined && tickets !== undefined && config.value.simApiUrl !== undefined
    ? { synthesize: createRemoteSynthesize({ baseUrl: config.value.simApiUrl, session, tickets }) }
    : undefined;
if (!agent.ok) log(configErrorEvent(agent.error));
const queryClient = new QueryClient();

// Dev-only card gallery (`?gallery&theme=light`): never part of a production build.
const params = new URLSearchParams(window.location.search);
const galleryTheme = params.get('theme') === 'light' ? 'light' : 'dark';
const Gallery =
  import.meta.env.DEV && params.has('gallery')
    ? lazy(() => import('./dev/Gallery.js').then((m) => ({ default: () => <m.Gallery hostTheme={galleryTheme} /> })))
    : null;

/** The correlation id of the home panel's card: one per page, as it is not part of a turn. */
const HOME_PANEL_TURN = crypto.randomUUID();

/** The simulated Alexa+ host: its theme is the hostContext.theme every card frame receives. */
function Simulator({ agent, config, session, studioVoice }: { agent: Agent; config: SimConfig; session: DemoSession | undefined; studioVoice: StudioVoice | undefined }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    document.documentElement.dataset['cardTheme'] = cardThemeFor(theme);
  }, [theme]);
  // Demo mode for the video: taps on the page are marked here, taps inside a card by the card itself.
  useEffect(() => {
    if (!config.demo) return undefined;
    document.documentElement.dataset['demo'] = '';
    const uninstall = installTapMarks(document);
    return () => {
      uninstall();
      delete document.documentElement.dataset['demo'];
    };
  }, [config.demo]);
  // The sky follows the weather the answers show (sky.ts); it starts on a mild day.
  const [sky, setSky] = useState<Sky>('mild');
  // "Show my home" (#204): the home the answers and the card actions describe (home.ts).
  const homeMode = config.agent === 'scripted' ? 'scripted' : 'remote';
  const [home, setHome] = useState(() => initialHome(homeMode));
  // Scripted mode (#268): whether an answer has said what the home is since the scenario was chosen.
  const [homeTold, setHomeTold] = useState(false);
  const subscribeSession = useCallback((listener: () => void) => (session ? session.subscribe(listener) : () => undefined), [session]);
  const sessionToken = useSyncExternalStore(subscribeSession, () => session?.token());
  // Remote mode with a demo code: until it is accepted there is no home to read (owner, 18 Oct).
  const needsCode = session !== undefined && sessionToken === undefined;
  // Remote mode (#262): the panel reads the home on demand, each time it opens and after a plan is applied.
  const [homeLoad, setHomeLoad] = useState<'idle' | 'loading' | 'failed'>('idle');
  const loadHome = useCallback(() => {
    if (homeMode !== 'remote' || (session !== undefined && session.token() === undefined)) return;
    setHomeLoad('loading');
    void fetchHome(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (read.ok) setHome(read.value);
      setHomeLoad(read.ok ? 'idle' : 'failed');
    });
  }, [agent, homeMode, session]);
  // Three bands (owner, 10 Oct): the home button in the header band, the home in the content band.
  // #432 S6: its button sits in the screen's menu; when the home closes with Escape the focus goes back to the menu.
  const menuRef = useRef<HTMLButtonElement>(null);
  const focusMenu = useCallback(() => {
    menuRef.current?.focus();
  }, []);
  // #432 S5: the settings are the screen's other page, one page at a time. The settings page is made further down (its
  // model needs the demo settings and the preferences); this ref closes it from here.
  const closeSettingsRef = useRef<() => void>(() => undefined);
  const closeSettings = useCallback(() => {
    closeSettingsRef.current();
  }, []);
  // The judge's demo settings (state/use-demo-settings). A new scenario starts on its own sky; each new play of a
  // sandbox reads the home and the phone again (Restart keeps the scenario, so without this the clock stayed where it
  // was, owner, 18 Oct). A home that is not a sandbox has no settings: the badge then opens the language row only (#284).
  const scripted = config.agent === 'scripted';
  const onScenario = useCallback((scenarioId: ScenarioId) => {
    setSky(skyOfScenario(scenarioId));
    setHomeTold(false);
  }, []);
  /** What follows a new play of the day or a move of the clock: the home and the phone are read again. */
  const readWhatFollows = useCallback(() => {
    loadHome();
    phone.refresh?.();
  }, [loadHome]);
  const demo = useDemoSettings({ agent, scripted, sessionToken, onScenario, onNewPlay: readWhatFollows });
  const demoSettings = demo.settings;
  // The day's turns used up after Start (dev-site check, 20 Oct): the screen and the home say so once, the questions are off.
  const closedNotice = demo.unavailable === undefined ? undefined : closedNoticeOf(demo.unavailable.error, demo.unavailable.at);
  const homePanel = useHomePanel({
    status: home,
    renderCard: (status) => <HomeCard status={status} />,
    load: needsCode ? 'locked' : homeLoad,
    ...(closedNotice === undefined ? {} : { closedNotice }),
    onOpen: loadHome,
    onShow: closeSettings,
    onRetry: loadHome,
    onFocusLost: focusMenu,
  });
  // The home opened before the code (its note asks for it): once the code is accepted it is read at once.
  const homeOpenRef = useRef(false);
  homeOpenRef.current = homePanel.view !== null;
  useEffect(() => {
    if (sessionToken !== undefined && homeOpenRef.current) loadHome();
  }, [sessionToken, loadHome]);
  const closeHome = homePanel.close;
  const onSettingsChange = demo.change;
  const playthrough = demo.playthrough;
  // Every time on screen (phone, cards, answers, sky) is on the home's own clock: the sandbox place's zone (Houston:
  // America/Chicago) when known, else the configured home zone; never the browser's or the server's.
  const homeTimeZone = demoSettings?.timeZone ?? config.homeTimeZone;
  // The home's face on the Echo (owner, 20 Oct, B): Leo, or a small house when no one at risk is at home.
  const homeFace = homeFaceOf(demoSettings?.household);
  const homeAvatar = homeFace.avatar;
  // The plan on screen (time pack): the simulated clock lists its own moments too (the essential level, the emergency plan).
  const [planId, setPlanId] = useState<string | undefined>(undefined);
  const onAnswer = useCallback(
    (answer: AgentAnswer) => {
      setSky((previous) => skyFor(answer.cards ?? [], homeTimeZone, previous));
      setHome((previous) => homeFor(answer.cards ?? [], previous, homeMode));
      if (homeFor(answer.cards ?? [], undefined, homeMode) !== undefined) setHomeTold(true);
      const shownPlan = planIdOf(answer.cards);
      if (shownPlan !== undefined) setPlanId(shownPlan);
      // A new answer takes the content band: the home or the settings close (their buttons say so).
      closeHome();
      closeSettings();
    },
    [homeTimeZone, homeMode, closeHome, closeSettings],
  );
  // The steps (idea 5): the turns whose plan was applied from its card are at "Confirm"; a last resort's first step
  // (still "proposed", waiting for the second yes) is not (review of #350).
  const [appliedTurns, setAppliedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const onCardAction = useCallback(
    (name: string, turnId: string, result: unknown) => {
      if (name !== 'apply_plan') return;
      if (isAppliedPlan(result)) setAppliedTurns((previous) => new Set(previous).add(turnId));
      setHome((previous) => homeAfterApply(previous, homeMode));
      loadHome();
    },
    [homeMode, loadHome],
  );
  // #402: the preferences and the limits they move inside (state/use-preferences), read with the sandbox and again when
  // its day or place changes. One instance for every view of the settings.
  const { limits, saveLimit: onLimit } = usePreferences({
    agent,
    enabled: scripted || sessionToken !== undefined,
    key: `${demoSettings?.scenarioId ?? ''}/${demoSettings?.locationId ?? ''}`,
  });
  const { locale, chooseLocale: onLocale } = useLocaleSetting();
  // The example buttons follow the home (#268). Remote mode: the home read from sim-api wins over the scenario.
  // Scripted mode: the scenario decides (its home starts calm whatever the scenario) until an answer says what the
  // home is (a storm starting, or the power coming back); that answer then wins (review of #301).
  const homeState = {
    ...(demoSettings === undefined ? {} : { scenarioId: demoSettings.scenarioId }),
    ...(home === undefined || (homeMode !== 'remote' && !homeTold) ? {} : { gridAvailable: home.gridAvailable }),
  };
  const examples = examplesFor(homeState);
  // The cold reserve clock on the idle screen (owner, 11 Oct): read on load and when the scenario or the grid changes,
  // never polled; a failed read leaves no clock, quietly (fetchReserve logs it). Its storm is the
  // examples' storm.
  const gridDown = isGridDown(homeState);
  // The simulated clock (state/use-sim-clock), for every visitor of a sandbox (or the scripted home).
  const hasSandbox = demoSettings !== undefined;
  const { clock, busy: clockBusy, note: clockNote, stops, skip: onSkip, cutPower, clearNote } = useSimClock({ agent, enabled: hasSandbox, scenario: demoSettings?.scenarioId, planId, playthrough, afterMove: readWhatFollows });
  // "Power cut" (time pack, 12 Oct): before the question reaches the agent, the simulated grid goes down (the storm
  // scenario, at its storm start), so the assistant answers a real outage and storm mode starts. The latest settings
  // are read through a ref: the turn may start before this render's settings are drawn.
  const settingsRef = useRef(demoSettings);
  settingsRef.current = demoSettings;
  const prepareTurn = useCallback(
    async (question: string, context: AskContext): Promise<Result<void, ErrorEnvelope>> => {
      const settings = settingsRef.current;
      // Not a sandbox (the shared demo home): nothing simulated to change, the agent answers as it is.
      if (!isPowerCut(question) || settings === undefined) return ok(undefined);
      // Ana's phone says whether the family already heard of this storm.
      const familyTold = phone.messages().some((m) => m.transition === 'storm_started');
      const cut = await cutPower({ stormScenario: settings.scenarioId === 'storm-blackout', familyTold, saveStorm: onSettingsChange }, context);
      if (!cut.ok) return cut;
      setSky('storm');
      return ok(undefined);
    },
    [cutPower, onSettingsChange],
  );
  const idleReading = { agent, enabled: scripted || sessionToken !== undefined, scenarioId: demoSettings?.scenarioId, gridDown, now: clock?.now };
  const reserve = useReserve(idleReading);
  // Leo's room on the idle screen (#432 S6, owner D2 = b): the server's "safe until", read again at every jump.
  const safeRoom = useSafeRoom(idleReading);
  // The bell of the Echo screen: Ana's messages not seen yet (the same feed as her phone, no reading more).
  const notices = useNotices(phone);
  // What the screen shows, for the layout: the sky is dimmed only behind an answer.
  const [screenState, setScreenState] = useState<ScreenState>('idle');
  // A change from the demo controls or the settings starts another day (or place): what the clock said about the old one goes.
  const onDrawerChange = useCallback(
    (change: SetScenarioInput) => {
      clearNote();
      return onSettingsChange(change);
    },
    [clearNote, onSettingsChange],
  );
  // Ana's messages: the jump summary counts them, and a new one opens her phone below the side-by-side width.
  const phoneMessages = useSyncExternalStore(phone.subscribe, phone.messages);
  const phoneCount = phoneMessages.length;
  // Ana's phone (#432, owner J = a): beside the Echo where it fits, else a sheet that also opens on a new message.
  const phoneBeside = useMediaQuery(PHONE_BESIDE);
  const phoneSheet = usePhoneSheet({ beside: phoneBeside, messages: phoneMessages, peekMs: config.phonePeekMs });
  // #432 S5: the person's own settings, one model for the Echo's page and Ana's phone (same data, same unsaved draft).
  // Without demo settings the page holds who we protect and the language only (#284).
  const settingsModel = useSettingsModel({ settings: demoSettings, onChange: onDrawerChange, limits, onLimit });
  // One view announces the page's lines (settingsAnnounce): under the phone's modal sheet the Echo's page is inert.
  const phoneModal = !phoneBeside && phoneSheet.open;
  const settingsView = <SettingsPage model={settingsModel} locale={locale} onLocale={onLocale} announce={settingsAnnounce('echo', { echoOpen: true, phoneModal })} />;
  const settingsPage = useSettingsPage({ model: settingsModel, render: () => settingsView, onShow: closeHome, onFocusLost: focusMenu });
  closeSettingsRef.current = settingsPage.close;
  // Back, or the idle screen coming back, closes the page on screen, whichever it is.
  const closeSettingsPage = settingsPage.close;
  const closePage = useCallback(() => {
    closeHome();
    closeSettingsPage();
  }, [closeHome, closeSettingsPage]);
  // The judges' demo controls (#432): a column beside the Echo on a wide screen (WIDE_CONTROLS: from 1600 px
  // at 3:2 or wider), a sheet behind the dashed button of the top bar elsewhere; removable by config (the real home keeps only
  // its own controls). The simulated clock and its jump stay under the Echo, big (#391), so the time is always in view.
  const demoShown = config.demoControls && hasSandbox;
  const wide = useMediaQuery(WIDE_CONTROLS);
  const sheet = useDemoControlsSheet();
  // A window that grows into the column while the sheet is open: the column shows, the sheet closes.
  const closeSheet = sheet.setOpen;
  useEffect(() => {
    if (wide) closeSheet(false);
  }, [wide, closeSheet]);
  // After each jump the panel says what changed, with the messages Ana got on the way: those sent after the time the
  // jump left and up to the time it reached (brief 3b; a later answer's message is never counted as the jump's).
  const jumpFrom = useRef<string | undefined>(undefined);
  const onJump = useCallback(() => {
    jumpFrom.current = clock?.now;
    onSkip();
  }, [clock?.now, onSkip]);
  const lastJump =
    clockNote?.kind === 'reached' && clock !== undefined ? { at: clock.now, kind: clockNote.moment, told: messagesBetween(phone.messages(), jumpFrom.current, clock.now) } : undefined;
  const clockDock = demoShown && clock !== undefined ? <SimClock state={clock} busy={clockBusy} onSkip={onJump} {...(clockNote === undefined ? {} : { note: clockNote })} summary={!wide && lastJump !== undefined ? jumpText(lastJump) : undefined} scenarioId={demoSettings.scenarioId} /> : undefined;
  // The title sits above the device, always in view (contest rule: "Simulated Alexa+ add-on" in plain words); the
  // screen itself has no app title, like the real Echo Show (#432 S6). The theme switch stays there: the settings page
  // holds the person's own settings only (brief of 18 Oct, point 2).
  const themeToggle = (
    <button
      type="button"
      className="link-button theme-toggle"
      aria-pressed={theme === 'light'}
      onClick={() => {
        setTheme(theme === 'light' ? 'dark' : 'light');
      }}
    >
      {/* On a phone the sun alone, its name for screen readers (controls.css). */}
      <IconFrame className="theme-icon">
        <WeatherOutline sky="mild" />
      </IconFrame>
      <span className="theme-label">{t('theme.toggle')}</span>
    </button>
  );
  // The judges' bar under the Echo, where the conversation draws its question field (#432 S6).
  const [askHost, setAskHost] = useState<HTMLDivElement | null>(null);
  // H (owner, 19 Oct): "Power cut" in the demo controls asks for the person; prepareTurn then cuts the grid first.
  const askRef = useRef<((question: string) => void) | null>(null);
  const onPowerCut = useCallback(() => {
    askRef.current?.(POWER_CUT_QUESTION);
  }, []);
  const topBar = (
    <>
      <Title />
      <DemoControlsOpener sheet={sheet} settings={demoSettings} hidden={!demoShown || wide} />
      <PhoneOpener sheet={phoneSheet} beside={phoneBeside} count={phoneCount} />
      <PhonePeek sheet={phoneSheet} timeZone={homeTimeZone} />
      {themeToggle}
      {/* The language icon at the top (owner, 10 Oct), at the end of the row. */}
      <LanguageToggle locale={locale} onLocale={onLocale} />
    </>
  );
  const demoControls = demoShown ? (
    <DemoControlsPanel sheet={sheet} wide={wide} settings={demoSettings} availablePlaces={SHIPPED_PLACES} onChange={onDrawerChange} stops={stops} now={clock?.now} lastJump={lastJump} onPowerCut={onPowerCut} />
  ) : undefined;
  // The family phone, always shown: scripted, the dev proxy's inbox, or (remote mode, #267) the sandbox inbox from sim-api.
  const phonePanel = (
    <ErrorBoundary>
      {/* Ana's page shows the same lines as the Echo's and announces them when the Echo's page is closed or under her sheet. */}
      <PhonePanel feed={phone} timeZone={homeTimeZone} units={demoSettings?.units ?? 'C'} named={homeFace.named} settings={<SettingsPage model={settingsModel} locale={locale} onLocale={onLocale} announce={settingsAnnounce('phone', { echoOpen: settingsPage.isOpen, phoneModal })} />} />
    </ErrorBoundary>
  );
  // The device layout from config (#432): the Alexa Echo Show unless configured; the judges' site always has it.
  const Layout = LAYOUTS[config.layout];
  return (
    <Layout
      state={{ sky, screen: screenState }}
      slots={{
        topBar,
        ...(demoControls === undefined ? {} : { demoControls }),
        companion: (
          <PhoneSheet sheet={phoneSheet} beside={phoneBeside}>
            {phonePanel}
          </PhoneSheet>
        ),
        ...(clockDock === undefined ? {} : { clock: clockDock }),
        // The judges' question bar under the Echo (#432 S6, owner I = a): the conversation draws its field here.
        askBar: <div className="ask-bar-host" ref={setAskHost} />,
        screen: (
          <CardHostProvider value={{ agent, documentFor: cardDocument, theme, timeZone: homeTimeZone, demo: config.demo, units: demoSettings?.units ?? 'C', place: demoSettings?.locationId, onCardAction }}>
            <QueryClientProvider client={queryClient}>
              <Conversation
                agent={agent}
                turnBudgetMs={config.turnBudgetMs}
                timeZone={homeTimeZone}
                voice={config.voice}
                demo={config.demo}
                onAnswer={onAnswer}
                examples={examples}
                commands={[
                  // The clock's button, said or typed (idea 4), while it has a moment to skip to: what is written on it can be said ("Go to 21:10").
                  ...(demoShown && clock?.next !== undefined && !clockBusy
                    ? [{ id: 'clock_skip', phrases: [t('clock.skip'), t('clock.skipUtterance'), t('clock.skipToShort', { time: clockTime(clock.next.at) }), t('clock.skipTo', { time: clockTime(clock.next.at), moment: t(`clock.kind.${clock.next.kind}`) })], run: onJump }]
                    : []),
                  { id: 'home_show', phrases: [t('home.show')], run: homePanel.open },
                  { id: 'home_hide', phrases: [t('home.hide')], run: homePanel.close },
                  { id: 'settings_show', phrases: [t('settings.open')], run: settingsPage.open },
                  { id: 'settings_hide', phrases: [t('settings.page.hide')], run: settingsPage.close },
                  { id: 'theme_light', phrases: [t('theme.toggle')], run: () => {
                      setTheme('light');
                    } },
                  { id: 'language', phrases: [t(`settings.language.${nextLocale(locale)}`)], run: () => {
                      onLocale(nextLocale(locale));
                    } },
                  { id: 'theme_dark', phrases: [t('theme.darkUtterance')], run: () => {
                      setTheme('dark');
                    } },
                ]}
                head={<ScreenTop now={clock?.now} sky={sky} unseen={notices.unseen} onSeen={notices.markSeen} menu={<>{homePanel.button}{settingsPage.button}</>} avatar={homeAvatar} menuRef={menuRef} />}
                pageView={settingsPage.view ?? homePanel.view}
                onClosePage={closePage}
                appliedTurns={appliedTurns}
                prepareTurn={prepareTurn}
                {...(hasSandbox && clock !== undefined ? { simNow: clock.now } : {})}
                playthrough={playthrough}
                idle={
                  <IdleTiles
                    room={safeRoom}
                    reserve={reserve === undefined ? undefined : <ReserveClock outlook={reserve} storm={gridDown} />}
                    next={demoShown ? clock?.next : undefined}
                    notice={notices.newest}
                    timeZone={homeTimeZone}
                    avatar={homeAvatar}
                    named={homeFace.named}
                  />
                }
                idleReturnMs={config.idleReturnMs}
                onScreen={setScreenState}
                actionsHost={askHost}
                askRef={askRef}
                greeting={greetingOf(clock?.now, safeRoom, homeFace.named)}
                {...(closedNotice === undefined ? {} : { closedNotice })}
                {...(session === undefined ? {} : { session })}
                {...(studioVoice === undefined ? {} : { studioVoice })}
              />
            </QueryClientProvider>
          </CardHostProvider>
        ),
      }}
    />
  );
}

/** The home panel's card: the same object while the home is unchanged, so the frame is not reloaded. */
function HomeCard({ status }: { status: HomeStatus }) {
  const card = useMemo(() => ({ tool: 'get_home_status' as const, result: status }), [status]);
  return <CardFrame card={card} turnId={HOME_PANEL_TURN} />;
}

function Title() {
  return (
    <header>
      {/* The project's mark (owner, 19 Oct), beside the name that says it, so decoration for screen readers. */}
      <img className="title-mark" src="/mark-on-dark.svg" alt="" width="24" height="24" />
      <h1>{t('sim.title')}</h1>
    </header>
  );
}

/** The gallery and the configuration error: the plain page, without the device. */
function Plain({ children }: { children: ReactNode }) {
  return (
    <main className="surface">
      <Title />
      {children}
    </main>
  );
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {Gallery !== null ? (
        <Plain>
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        </Plain>
      ) : config.ok && config.value.view === 'phone' ? (
        // ?view=phone (#269): only Ana's phone, never the scripted answers (their numbers are fixed).
        <Plain>
          <p className="muted" data-testid="phone-only-note">
            {t('phone.onlyInbox')}
          </p>
          <ErrorBoundary>
            {/* No demo settings here: the dev proxy reads the local demo home, which has no unit setting, so °C (review of #308). */}
            <PhonePanel feed={phone} timeZone={config.value.homeTimeZone} units="C" />
          </ErrorBoundary>
        </Plain>
      ) : config.ok && agent.ok ? (
        <Simulator agent={agent.value} config={config.value} session={session} studioVoice={studioVoice} />
      ) : (
        <Plain>
          <p role="alert">{t('config.invalid')}</p>
        </Plain>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
