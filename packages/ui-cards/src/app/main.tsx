import { useApp, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { t } from '../text.js';
import { cardThemeFor } from '../theme.js';
import { CardApp } from './CardApp.js';
import { isCardKind, isStormState, parseCardResult, parseSaveResult, safeTimeZone, type CardKind, type CardState } from './card-kinds.js';

// Entry of the ui:// card bundle. The document names its card (data-card); the host sends the tool
// result and the context (theme, time zone) through the MCP Apps bridge. Covered by the host e2e tests.

type Context = Pick<McpUiHostContext, 'theme' | 'timeZone'>;

function Card({ kind }: { kind: CardKind }) {
  const [state, setState] = useState<CardState>({ kind: 'waiting' });
  const [context, setContext] = useState<Context>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  const { app, error } = useApp({
    appInfo: { name: 'cold-reserve-cards', version: '0.1.0' },
    capabilities: {},
    onAppCreated: (created) => {
      created.addEventListener('toolresult', (result) => {
        setState(parseCardResult(kind, result));
      });
      created.addEventListener('hostcontextchanged', ({ theme, timeZone }) => {
        setContext((previous) => ({ ...previous, ...(theme !== undefined && { theme }), ...(timeZone !== undefined && { timeZone }) }));
      });
    },
  });

  useEffect(() => {
    const initial = app?.getHostContext();
    if (initial) setContext({ ...(initial.theme !== undefined && { theme: initial.theme }), ...(initial.timeZone !== undefined && { timeZone: initial.timeZone }) });
  }, [app]);

  useEffect(() => {
    document.documentElement.dataset['cardTheme'] = cardThemeFor(context.theme);
  }, [context.theme]);

  useEffect(() => {
    document.documentElement.classList.toggle('theme-storm', isStormState(state));
  }, [state]);

  if (error) return <p role="alert">{t('card.failed')}</p>;
  return (
    <CardApp
      state={state}
      timeZone={safeTimeZone(context.timeZone)}
      {...(notice !== undefined && { notice })}
      onCallTool={(name, args) => {
        void app
          ?.callServerTool({ name, arguments: args })
          .then((result) => {
            // Apply turns this frame into the applied plan; Save says whether it worked and shows the new values.
            if (name === 'apply_plan') setState(parseCardResult('applied', result));
            if (name === 'set_preferences') {
              const saved = parseSaveResult(result);
              setNotice(saved.ok ? { ok: true, text: t('prefs.saved') } : { ok: false, text: saved.error });
              if (saved.ok) setState((current) => (current.kind === 'preferences' ? { ...current, data: { ...current.data, preferences: saved.value } } : current));
            }
          })
          .catch((reason: unknown) => {
            console.warn(JSON.stringify({ level: 'warn', component: 'ui-cards', code: 'unexpected_error', tool: name, reason: String(reason) }));
            setState({ kind: 'error', message: t('card.failed'), retryable: true });
          });
      }}
    />
  );
}

const root = document.getElementById('root');
const kind = root?.dataset['card'];
if (root && isCardKind(kind)) {
  createRoot(root).render(
    <StrictMode>
      <Card kind={kind} />
    </StrictMode>,
  );
}
