import '@cold-reserve/design-tokens/tokens.css';
import '@cold-reserve/ui-cards/cubes.css';
import './app.css';
import { categoryOf, ok, type ErrorEnvelope, type GetPreferencesOutput, type HomeStatus, type ReserveOutlook, type Result, type SetScenarioInput } from '@cold-reserve/contracts';
import { getLocale, setLocale, subscribeLocale, type Locale } from '@cold-reserve/i18n';
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
import { CardFrame } from './host/CardFrame.js';
import { EchoFrame } from './ui/EchoFrame.js';
import { examplesFor, isGridDown } from './ui/ExampleQuestions.js';
import { fetchHome, homeAfterApply, homeFor, initialHome } from './ui/home.js';
import { useHomePanel } from './ui/HomePanel.js';
import { ReserveClock } from './ui/ReserveClock.js';
import { SimClock, type ClockNote } from './ui/SimClock.js';
import { clockTime, cutThePower, isPowerCut, planIdOf, readClock, skipAhead, type ClockState } from './ui/sim-clock.js';
import { isAppliedPlan } from './ui/steps.js';
import { fetchReserve } from './ui/reserve.js';
import { SHIPPED_PLACES, applyChange, fetchDemoSettings, saveDemoSettings, scriptedDemoSettings, skyOfScenario, type DemoSettingsView } from './ui/demo-settings.js';
import { DemoSettingsControl, type LimitSave } from './ui/SettingsDrawer.js';
import { withSaved, type LimitChange } from './ui/limits.js';
import { fetchPreferences, savePreferences } from './ui/preferences-settings.js';
import { LanguageToggle, nextLocale } from './ui/LanguageToggle.js';
import { readLocale, saveLocale } from './ui/locale-setting.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { skyFor, type Sky } from './ui/sky.js';
import { t } from './ui/text.js';
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
  const homePanel = useHomePanel({ status: home, renderCard: (status) => <HomeCard status={status} />, load: needsCode ? 'locked' : homeLoad, onOpen: loadHome, onRetry: loadHome });
  // The home opened before the code (its note asks for it): once the code is accepted it is read at once.
  const homeOpenRef = useRef(false);
  homeOpenRef.current = homePanel.view !== null;
  useEffect(() => {
    if (sessionToken !== undefined && homeOpenRef.current) loadHome();
  }, [sessionToken, loadHome]);
  const closeHome = homePanel.close;
  // The judge's demo settings (B1, B2): kept in the page in scripted mode; in remote mode read from the visitor's
  // sandbox once the demo session starts, and saved there (what is shown is what is stored). A new scenario starts on
  // its own sky. A home that is not a sandbox has no settings: the badge then opens the language row only (#284).
  const scripted = config.agent === 'scripted';
  const [demoSettings, setDemoSettings] = useState<DemoSettingsView | undefined>(() => (scripted ? scriptedDemoSettings() : undefined));
  // Every time on screen (phone, cards, answers, sky) is on the home's own clock: the sandbox place's zone (Houston:
  // America/Chicago) when known, else the configured home zone; never the browser's or the server's.
  const homeTimeZone = demoSettings?.timeZone ?? config.homeTimeZone;
  // The plan on screen (time pack): the simulated clock lists its own moments too (the essential level, the emergency plan).
  const [planId, setPlanId] = useState<string | undefined>(undefined);
  const onAnswer = useCallback(
    (answer: AgentAnswer) => {
      setSky((previous) => skyFor(answer.cards ?? [], homeTimeZone, previous));
      setHome((previous) => homeFor(answer.cards ?? [], previous, homeMode));
      if (homeFor(answer.cards ?? [], undefined, homeMode) !== undefined) setHomeTold(true);
      const shownPlan = planIdOf(answer.cards);
      if (shownPlan !== undefined) setPlanId(shownPlan);
      // A new answer takes the content band: the home closes (its button says so).
      closeHome();
    },
    [homeTimeZone, homeMode, closeHome],
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
  useEffect(() => {
    if (scripted || sessionToken === undefined) return;
    void fetchDemoSettings(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (read.ok) setDemoSettings(read.value);
    });
  }, [agent, scripted, sessionToken]);
  // Each new play of the day (Restart the day, a new scenario or place: the server starts the day again): the clock,
  // the home and the phone are read again. Restart keeps the scenario, so without this the clock stayed where it was
  // (owner, 18 Oct).
  const [playthrough, setPlaythrough] = useState(0);
  const onSettingsChange = useCallback(
    async (change: SetScenarioInput) => {
      const newPlay = change.restart === true || change.scenarioId !== undefined || change.locationId !== undefined;
      if (scripted) {
        setDemoSettings((previous) => (previous === undefined ? previous : applyChange(previous, change)));
        // The scripted home plays the same change, so its simulated clock follows the scenario.
        await agent.callTool('set_scenario', { ...change }, { correlationId: crypto.randomUUID() });
        if (change.scenarioId !== undefined) {
          setSky(skyOfScenario(change.scenarioId));
          setHomeTold(false);
        }
        if (newPlay) setPlaythrough((n) => n + 1);
        return true;
      }
      const saved = await saveDemoSettings(agent, change, { correlationId: crypto.randomUUID() });
      if (!saved.ok) return false;
      setDemoSettings(saved.value);
      if (change.scenarioId !== undefined || change.restart === true) setSky(skyOfScenario(saved.value.scenarioId));
      if (newPlay) {
        setPlaythrough((n) => n + 1);
        loadHome();
        phone.refresh?.();
      }
      return true;
    },
    [agent, scripted, loadHome],
  );
  // #402: the preferences and the limits they move inside, for the temperatures and limits section of the drawer.
  // Read with the sandbox (and again when its day or place changes); a failed read leaves the section without them.
  const [limits, setLimits] = useState<GetPreferencesOutput | undefined>(undefined);
  const limitsKey = `${demoSettings?.scenarioId ?? ''}/${demoSettings?.locationId ?? ''}`;
  useEffect(() => {
    if (!scripted && sessionToken === undefined) return undefined;
    let current = true;
    void fetchPreferences(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok) setLimits(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, scripted, sessionToken, limitsKey]);
  const onLimit = useCallback(
    async (change: LimitChange): Promise<LimitSave> => {
      const saved = await savePreferences(agent, change, { correlationId: crypto.randomUUID() });
      // What the tool stored is what is shown: the view comes from its output, with no second read.
      if (saved.ok) {
        setLimits((previous) => (previous === undefined ? previous : withSaved(previous, saved.value.preferences)));
        return 'saved';
      }
      return categoryOf(saved.error.code) === 'rate_limited' ? 'rate_limited' : 'failed';
    },
    [agent],
  );
  // #263: the page's language, this viewer's own setting kept in the browser; every text re-renders with it.
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const onLocale = useCallback((next: Locale) => {
    setLocale(next);
    saveLocale(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale.slice(0, 2);
    document.title = t('sim.title');
  }, [locale]);
  // The badge is always there: without demo settings it opens the language row only (#284).
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
  // The simulated clock (owner decision, 10 Oct; time pack, 12 Oct): for every visitor of a sandbox (or the scripted
  // home), read when the scenario or the plan on screen changes, and after each move; never polled.
  const [clock, setClock] = useState<ClockState | undefined>(undefined);
  const [clockNote, setClockNote] = useState<ClockNote | undefined>(undefined);
  const [clockBusy, setClockBusy] = useState(false);
  const hasSandbox = demoSettings !== undefined;
  const clockScenario = demoSettings?.scenarioId;
  // Each move of the clock counts: a read started before a move never draws over the clock the move left.
  const clockMoves = useRef(0);
  useEffect(() => {
    if (!hasSandbox) return undefined;
    let current = true;
    const moves = clockMoves.current;
    void readClock(agent, planId, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok && moves === clockMoves.current) setClock(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, hasSandbox, clockScenario, planId, playthrough]);
  /** What follows a move of the clock: the home, the phone and the reserve are read again. */
  const afterMove = useCallback(() => {
    loadHome();
    phone.refresh?.();
  }, [loadHome]);
  const onSkip = useCallback(() => {
    if (clockBusy) return;
    setClockBusy(true);
    clockMoves.current += 1;
    void skipAhead(agent, planId, { correlationId: crypto.randomUUID() }).then((moved) => {
      setClockBusy(false);
      if (!moved.ok) {
        // A daily limit says so, never "Try again" (review of #378).
        setClockNote(moved.error.code === 'demo_quota_exceeded' ? { kind: 'limit' } : { kind: 'failed' });
        return;
      }
      clockMoves.current += 1;
      setClock(moved.value.state);
      setClockNote({ kind: 'reached', moment: moved.value.reached.kind });
      afterMove();
    });
  }, [agent, planId, clockBusy, afterMove]);
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
      clockMoves.current += 1;
      // Ana's phone says whether the family already heard of this storm.
      const familyTold = phone.messages().some((m) => m.transition === 'storm_started');
      const cut = await cutThePower(agent, { stormScenario: settings.scenarioId === 'storm-blackout', familyTold, saveStorm: onSettingsChange }, context);
      if (!cut.ok) return cut;
      clockMoves.current += 1;
      setClock(cut.value.state);
      setClockNote(cut.value.changed ? { kind: 'grid_down' } : undefined);
      setSky('storm');
      afterMove();
      return ok(undefined);
    },
    [agent, onSettingsChange, afterMove],
  );
  const [reserve, setReserve] = useState<ReserveOutlook | undefined>(undefined);
  const scenarioId = demoSettings?.scenarioId;
  useEffect(() => {
    // A new scenario or grid: the old hours go first (never a calm day's hours beside a melting cube), and a reply
    // that comes after the next change is dropped.
    setReserve(undefined);
    if (!scripted && sessionToken === undefined) return undefined;
    let current = true;
    void fetchReserve(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok) setReserve(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, scripted, sessionToken, scenarioId, gridDown, clock?.now]);
  // A change from the drawer starts another day (or place): what the clock said about the old one goes.
  const onDrawerChange = useCallback(
    (change: SetScenarioInput) => {
      setClockNote(undefined);
      return onSettingsChange(change);
    },
    [onSettingsChange],
  );
  // The simulated clock sits under the Echo frame, big (#391): the top bar's pill was not noticed.
  const clockDock = hasSandbox && clock !== undefined ? <SimClock state={clock} busy={clockBusy} onSkip={onSkip} {...(clockNote === undefined ? {} : { note: clockNote })} /> : undefined;
  const settingsControl = (
    <>
      <DemoSettingsControl settings={demoSettings} availablePlaces={SHIPPED_PLACES} onChange={onDrawerChange} locale={locale} onLocale={onLocale} limits={limits} onLimit={onLimit} />
      {/* The language icon at the top (owner, 10 Oct), at the end of the row, quiet beside the badge. */}
      <LanguageToggle locale={locale} onLocale={onLocale} />
    </>
  );
  // The family phone, always shown: scripted, the dev proxy's inbox, or (remote mode, #267) the sandbox inbox from sim-api.
  const phonePanel = (
    <ErrorBoundary>
      <PhonePanel feed={phone} timeZone={homeTimeZone} units={demoSettings?.units ?? 'C'} />
    </ErrorBoundary>
  );
  return (
    <EchoFrame sky={sky} aside={phonePanel} top={settingsControl} {...(clockDock === undefined ? {} : { dock: clockDock })}>
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
              ...(hasSandbox && clock?.next !== undefined && !clockBusy
                ? [{ id: 'clock_skip', phrases: [t('clock.skip'), t('clock.skipUtterance'), t('clock.skipToShort', { time: clockTime(clock.next.at) }), t('clock.skipTo', { time: clockTime(clock.next.at), moment: t(`clock.kind.${clock.next.kind}`) })], run: onSkip }]
                : []),
              { id: 'home_show', phrases: [t('home.show')], run: homePanel.open },
              { id: 'home_hide', phrases: [t('home.hide')], run: homePanel.close },
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
            head={
              <>
                <Title />
                {homePanel.button}
                <button
                  type="button"
                  className="link-button theme-toggle"
                  aria-pressed={theme === 'light'}
                  onClick={() => {
                    setTheme(theme === 'light' ? 'dark' : 'light');
                  }}
                >
                  {t('theme.toggle')}
                </button>
              </>
            }
            homeView={homePanel.view}
            onCloseHome={homePanel.close}
            appliedTurns={appliedTurns}
            prepareTurn={prepareTurn}
            {...(hasSandbox && clock !== undefined ? { simNow: clock.now } : {})}
            playthrough={playthrough}
            {...(reserve === undefined ? {} : { idle: <ReserveClock outlook={reserve} storm={gridDown} /> })}
            {...(session === undefined ? {} : { session })}
            {...(studioVoice === undefined ? {} : { studioVoice })}
          />
        </QueryClientProvider>
      </CardHostProvider>
    </EchoFrame>
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
