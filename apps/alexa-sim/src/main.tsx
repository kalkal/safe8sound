import '@cold-reserve/design-tokens/tokens.css';
import './app.css';
import { cardThemeFor } from '@cold-reserve/ui-cards';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent } from './agent/agent.js';
import { buildAgent } from './agent/index.js';
import { parseConfig, type SimConfig } from './config.js';
import { cardDocument } from './host/card-documents.js';
import { CardHostProvider } from './host/card-host.js';
import { Conversation } from './ui/Conversation.js';
import { log, logUnhandled } from './log.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { t } from './ui/text.js';

logUnhandled(window);
const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');
document.title = t('sim.title');

const config = parseConfig(import.meta.env, window.location.search, import.meta.env.DEV);
const agent = config.ok ? buildAgent(config.value) : config;
if (!agent.ok) log({ level: 'error', code: agent.error.code, details: { step: 'config', ...(agent.error.details?.field !== undefined && { field: agent.error.details.field }) } });
const queryClient = new QueryClient();

// Dev-only card gallery (`?gallery&theme=light`): never part of a production build.
const params = new URLSearchParams(window.location.search);
const galleryTheme = params.get('theme') === 'light' ? 'light' : 'dark';
const Gallery =
  import.meta.env.DEV && params.has('gallery')
    ? lazy(() => import('./dev/Gallery.js').then((m) => ({ default: () => <m.Gallery hostTheme={galleryTheme} /> })))
    : null;

/** The simulated Alexa+ host: its theme is the hostContext.theme every card frame receives. */
function Simulator({ agent, config }: { agent: Agent; config: SimConfig }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    document.documentElement.dataset['cardTheme'] = cardThemeFor(theme);
  }, [theme]);
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
      <CardHostProvider value={{ agent, documentFor: cardDocument, theme, timeZone: config.homeTimeZone }}>
        <QueryClientProvider client={queryClient}>
          <Conversation agent={agent} turnBudgetMs={config.turnBudgetMs} timeZone={config.homeTimeZone} />
        </QueryClientProvider>
      </CardHostProvider>
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
          <Simulator agent={agent.value} config={config.value} />
        ) : (
          <p role="alert">{t('config.invalid')}</p>
        )}
      </ErrorBoundary>
    </main>
  </StrictMode>,
);
