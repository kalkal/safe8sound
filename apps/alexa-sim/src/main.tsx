import '@cold-reserve/design-tokens/tokens.css';
import './app.css';
import type { HomeStatus, SetScenarioInput } from '@cold-reserve/contracts';
import { getLocale, setLocale, subscribeLocale, type Locale } from '@cold-reserve/i18n';
import { cardThemeFor, installTapMarks } from '@cold-reserve/ui-cards';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent, AgentAnswer } from './agent/agent.js';
import { buildAgent, buildSession, type DemoSession } from './agent/index.js';
import { parseConfig, type SimConfig } from './config.js';
import { cardDocument } from './host/card-documents.js';
import { CardHostProvider } from './host/card-host.js';
import { Conversation } from './ui/Conversation.js';
import { configErrorEvent, log, logUnhandled } from './log.js';
import { createInboxPhone } from './phone/inbox-phone.js';
import { createScriptedPhone, type PhoneFeed } from './phone/phone-feed.js';
import { PhonePanel } from './phone/PhonePanel.js';
import { CardFrame } from './host/CardFrame.js';
import { EchoFrame } from './ui/EchoFrame.js';
import { examplesFor } from './ui/ExampleQuestions.js';
import { fetchHome, homeAfterApply, homeFor, initialHome } from './ui/home.js';
import { HomePanel } from './ui/HomePanel.js';
import { SHIPPED_PLACES, applyChange, fetchDemoSettings, saveDemoSettings, scriptedDemoSettings, skyOfScenario, type DemoSettingsView } from './ui/demo-settings.js';
import { DemoSettingsControl } from './ui/SettingsDrawer.js';
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
  const onAnswer = useCallback(
    (answer: AgentAnswer) => {
      setSky((previous) => skyFor(answer.cards ?? [], config.homeTimeZone, previous));
      setHome((previous) => homeFor(answer.cards ?? [], previous, homeMode));
      if (homeFor(answer.cards ?? [], undefined, homeMode) !== undefined) setHomeTold(true);
    },
    [config.homeTimeZone, homeMode],
  );
  // Remote mode (#262): the panel reads the home on demand, each time it opens and after a plan is applied.
  const [homeLoad, setHomeLoad] = useState<'idle' | 'loading' | 'failed'>('idle');
  const loadHome = useCallback(() => {
    if (homeMode !== 'remote') return;
    setHomeLoad('loading');
    void fetchHome(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (read.ok) setHome(read.value);
      setHomeLoad(read.ok ? 'idle' : 'failed');
    });
  }, [agent, homeMode]);
  const onCardAction = useCallback(
    (name: string) => {
      if (name !== 'apply_plan') return;
      setHome((previous) => homeAfterApply(previous, homeMode));
      loadHome();
    },
    [homeMode, loadHome],
  );
  // The judge's demo settings (B1, B2): kept in the page in scripted mode; in remote mode read from the visitor's
  // sandbox once the demo session starts, and saved there (what is shown is what is stored). A new scenario starts on
  // its own sky. A home that is not a sandbox has no settings: the badge then opens the language row only (#284).
  const scripted = config.agent === 'scripted';
  const [demoSettings, setDemoSettings] = useState<DemoSettingsView | undefined>(() => (scripted ? scriptedDemoSettings() : undefined));
  const subscribeSession = useCallback((listener: () => void) => (session ? session.subscribe(listener) : () => undefined), [session]);
  const sessionToken = useSyncExternalStore(subscribeSession, () => session?.token());
  useEffect(() => {
    if (scripted || sessionToken === undefined) return;
    void fetchDemoSettings(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (read.ok) setDemoSettings(read.value);
    });
  }, [agent, scripted, sessionToken]);
  const onSettingsChange = useCallback(
    async (change: SetScenarioInput) => {
      if (scripted) {
        setDemoSettings((previous) => (previous === undefined ? previous : applyChange(previous, change)));
        if (change.scenarioId !== undefined) {
          setSky(skyOfScenario(change.scenarioId));
          setHomeTold(false);
        }
        return true;
      }
      const saved = await saveDemoSettings(agent, change, { correlationId: crypto.randomUUID() });
      if (!saved.ok) return false;
      setDemoSettings(saved.value);
      if (change.scenarioId !== undefined || change.restart === true) setSky(skyOfScenario(saved.value.scenarioId));
      return true;
    },
    [agent, scripted],
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
  const examples = examplesFor({
    ...(demoSettings === undefined ? {} : { scenarioId: demoSettings.scenarioId }),
    ...(home === undefined || (homeMode !== 'remote' && !homeTold) ? {} : { gridAvailable: home.gridAvailable }),
  });
  const settingsControl = (
      <DemoSettingsControl settings={demoSettings} availablePlaces={SHIPPED_PLACES} onChange={onSettingsChange} locale={locale} onLocale={onLocale} />
  );
  // The family phone, always shown: scripted, the dev proxy's inbox, or (remote mode, #267) the sandbox inbox from sim-api.
  const phonePanel = (
    <ErrorBoundary>
      <PhonePanel feed={phone} timeZone={config.homeTimeZone} units={demoSettings?.units ?? 'C'} />
    </ErrorBoundary>
  );
  return (
    <EchoFrame sky={sky} aside={phonePanel} top={settingsControl}>
      <Title />
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
      <CardHostProvider value={{ agent, documentFor: cardDocument, theme, timeZone: config.homeTimeZone, demo: config.demo, units: demoSettings?.units ?? 'C', onCardAction }}>
        <HomePanel status={home} renderCard={(status) => <HomeCard status={status} />} load={homeLoad} onOpen={loadHome} onRetry={loadHome} />
        <QueryClientProvider client={queryClient}>
          <Conversation agent={agent} turnBudgetMs={config.turnBudgetMs} timeZone={config.homeTimeZone} voice={config.voice} demo={config.demo} onAnswer={onAnswer} examples={examples} {...(session === undefined ? {} : { session })} {...(studioVoice === undefined ? {} : { studioVoice })} />
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
