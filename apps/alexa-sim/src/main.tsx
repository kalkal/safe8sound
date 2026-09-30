import '@cold-reserve/design-tokens/tokens.css';
import './app.css';
import { cardThemeFor } from '@cold-reserve/ui-cards';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { buildAgent } from './agent/index.js';
import { parseConfig } from './config.js';
import { Conversation } from './ui/Conversation.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { t } from './ui/text.js';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');
document.title = t('sim.title');

const config = parseConfig(import.meta.env, window.location.search, import.meta.env.DEV);
const agent = config.ok ? buildAgent(config.value) : config;
if (!agent.ok) console.error('invalid simulator config', agent.error);
const queryClient = new QueryClient();

// Dev-only card gallery (`?gallery&theme=light`): never part of a production build.
const params = new URLSearchParams(window.location.search);
const galleryTheme = params.get('theme') === 'light' ? 'light' : 'dark';
// Dev only: `?theme=light` plays the host theme for the whole page (the MCP Apps host sets it in PR 2b).
if (import.meta.env.DEV && params.has('theme')) document.documentElement.dataset['cardTheme'] = cardThemeFor(galleryTheme);
const Gallery =
  import.meta.env.DEV && params.has('gallery')
    ? lazy(() => import('./dev/Gallery.js').then((m) => ({ default: () => <m.Gallery hostTheme={galleryTheme} /> })))
    : null;

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
          <QueryClientProvider client={queryClient}>
            <Conversation
              agent={agent.value}
              turnBudgetMs={config.value.turnBudgetMs}
              timeZone={config.value.homeTimeZone}
              {...(config.value.agent === 'scripted' && { origin: 'simulated' as const })}
            />
          </QueryClientProvider>
        ) : (
          <p role="alert">{t('config.invalid')}</p>
        )}
      </ErrorBoundary>
    </main>
  </StrictMode>,
);
