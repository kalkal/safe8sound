import '@cold-reserve/design-tokens/tokens.css';
import './app.css';
import { cardThemeFor, installTapMarks } from '@cold-reserve/ui-cards';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent } from './agent/agent.js';
import { buildAgent, buildSession, type DemoSession } from './agent/index.js';
import { parseConfig, type SimConfig } from './config.js';
import { cardDocument } from './host/card-documents.js';
import { CardHostProvider } from './host/card-host.js';
import { Conversation } from './ui/Conversation.js';
import { configErrorEvent, log, logUnhandled } from './log.js';
import { createInboxPhone } from './phone/inbox-phone.js';
import { createScriptedPhone, type PhoneFeed } from './phone/phone-feed.js';
import { PhonePanel } from './phone/PhonePanel.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { t } from './ui/text.js';
import type { StudioVoice } from './voice/use-voice.js';
import { createRemoteSynthesize, createSpeechTickets } from './voice/studio-voice.js';

logUnhandled(window);
const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');
document.title = t('sim.title');

const config = parseConfig(import.meta.env, window.location.search, import.meta.env.DEV);
// The family phone (surface C, #24): the scripted scene's messages, or the real inbox read through the
// dev server's proxy, which adds the phone token (the browser never holds it).
const scriptedPhone = config.ok && config.value.phone === 'scripted' ? createScriptedPhone() : undefined;
const phone: PhoneFeed =
  scriptedPhone ??
  createInboxPhone({ fetchFn: (url, init) => fetch(url, init), pollMs: config.ok ? config.value.phonePollMs : 5_000, log, newId: () => crypto.randomUUID() });
// The demo session of remote mode (#101): the code is exchanged for a token, never stored.
const session = config.ok ? buildSession(config.value) : undefined;
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
  return (
    <>
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
      <CardHostProvider value={{ agent, documentFor: cardDocument, theme, timeZone: config.homeTimeZone, demo: config.demo }}>
        <QueryClientProvider client={queryClient}>
          <Conversation agent={agent} turnBudgetMs={config.turnBudgetMs} timeZone={config.homeTimeZone} voice={config.voice} demo={config.demo} {...(session === undefined ? {} : { session })} {...(studioVoice === undefined ? {} : { studioVoice })} />
        </QueryClientProvider>
      </CardHostProvider>
      {(config.agent === 'scripted' || config.phone === 'inbox') && (
        <ErrorBoundary>
          <PhonePanel feed={phone} timeZone={config.homeTimeZone} />
        </ErrorBoundary>
      )}
    </>
  );
}

createRoot(container).render(
  <StrictMode>
    <main className="surface">
      <header>
        <h1>{t('sim.title')}</h1>
      </header>
      <ErrorBoundary>
        {Gallery !== null ? (
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        ) : config.ok && agent.ok ? (
          <Simulator agent={agent.value} config={config.value} session={session} studioVoice={studioVoice} />
        ) : (
          <p role="alert">{t('config.invalid')}</p>
        )}
      </ErrorBoundary>
    </main>
  </StrictMode>,
);
