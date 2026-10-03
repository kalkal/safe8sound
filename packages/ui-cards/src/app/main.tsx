import { useApp, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { t } from '../text.js';
import { cardThemeFor } from '../theme.js';
import { CardApp } from './CardApp.js';
import { log, logUnhandled } from './card-log.js';
import { isCardKind, isStormState, parseCardResult, parseSaveResult, safeTimeZone, type CardKind, type CardState } from './card-kinds.js';

// Entry of the ui:// card bundle. The document names its card (data-card); the host sends the tool
// result and the context (theme, time zone) through the MCP Apps bridge. Covered by the host e2e tests.

type Context = Pick<McpUiHostContext, 'theme' | 'timeZone' | 'displayMode' | 'availableDisplayModes'>;

function Card({ kind }: { kind: CardKind }) {
  const [state, setState] = useState<CardState>({ kind: 'waiting' });
  const [context, setContext] = useState<Context>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  const { app, error } = useApp({
    appInfo: { name: 'cold-reserve-cards', version: '0.1.0' },
    // The card can be shown inline or full screen (#200); the host decides which it offers.
    capabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    onAppCreated: (created) => {
      created.addEventListener('toolresult', (result) => {
        setState(parseCardResult(kind, result));
      });
      created.addEventListener('hostcontextchanged', ({ theme, timeZone, displayMode, availableDisplayModes }) => {
        setContext((previous) => ({
          ...previous,
          ...(theme !== undefined && { theme }),
          ...(timeZone !== undefined && { timeZone }),
          ...(displayMode !== undefined && { displayMode }),
          ...(availableDisplayModes !== undefined && { availableDisplayModes }),
        }));
      });
    },
  });

  useEffect(() => {
    const initial = app?.getHostContext();
    if (initial) {
      setContext({
        ...(initial.theme !== undefined && { theme: initial.theme }),
        ...(initial.timeZone !== undefined && { timeZone: initial.timeZone }),
        ...(initial.displayMode !== undefined && { displayMode: initial.displayMode }),
        ...(initial.availableDisplayModes !== undefined && { availableDisplayModes: initial.availableDisplayModes }),
      });
    }
  }, [app]);

  useEffect(() => {
    document.documentElement.dataset['cardTheme'] = cardThemeFor(context.theme);
  }, [context.theme]);

  useEffect(() => {
    document.documentElement.classList.toggle('theme-storm', isStormState(state));
  }, [state]);

  // Full screen for the whole frame, only through the host and only when it offers it (#200).
  const fullscreen = context.displayMode === 'fullscreen';
  const toggleDisplay = useCallback(() => {
    void app
      ?.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' })
      .then(({ mode }) => {
        setContext((previous) => ({ ...previous, displayMode: mode }));
      })
      .catch((error: unknown) => {
        log({ level: 'warn', code: 'display_mode_failed', error });
      });
  }, [app, fullscreen]);

  if (error) return <p role="alert">{t('card.failed')}</p>;
  return (
    <CardApp
      state={state}
      timeZone={safeTimeZone(context.timeZone)}
      canAct={app?.getHostCapabilities()?.serverTools !== undefined}
      display={{ canFullscreen: context.availableDisplayModes?.includes('fullscreen') === true, fullscreen, toggle: toggleDisplay }}
      {...(notice !== undefined && { notice })}
      onCallTool={(name, args) => {
        void app
          ?.callServerTool({ name, arguments: args })
          .then((result) => {
            // Apply turns this frame into the applied plan; Save says whether it worked and shows the new values.
            if (name === 'apply_plan') {
              const next = parseCardResult('applied', result);
              setState(next.kind === 'applied' ? { ...next, fromThisFrame: true } : next);
            }
            if (name === 'set_preferences') {
              const saved = parseSaveResult(result);
              setNotice(saved.ok ? { ok: true, text: t('prefs.saved') } : { ok: false, text: saved.error });
              if (saved.ok) setState((current) => (current.kind === 'preferences' ? { ...current, data: { ...current.data, preferences: saved.value } } : current));
            }
          })
          .catch((error: unknown) => {
            log({ level: 'warn', code: 'unexpected_error', error, details: { tool: name } });
            setState({ kind: 'error', message: t('card.failed'), retryable: true });
          });
      }}
    />
  );
}

logUnhandled(window);
const root = document.getElementById('root');
const kind = root?.dataset['card'];
if (root && isCardKind(kind)) {
  createRoot(root).render(
    <StrictMode>
      <Card kind={kind} />
    </StrictMode>,
  );
}
