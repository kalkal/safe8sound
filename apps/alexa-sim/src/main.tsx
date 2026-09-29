import '@cold-reserve/design-tokens/tokens.css';
import './app.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
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

createRoot(container).render(
  <StrictMode>
    <main className="surface">
      <header>
        <h1>{t('sim.title')}</h1>
      </header>
      <ErrorBoundary>
        {config.ok && agent.ok ? (
          <QueryClientProvider client={queryClient}>
            <Conversation agent={agent.value} turnBudgetMs={config.value.turnBudgetMs} />
          </QueryClientProvider>
        ) : (
          <p role="alert">{t('config.invalid')}</p>
        )}
      </ErrorBoundary>
    </main>
  </StrictMode>,
);
