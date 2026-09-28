import { useApp, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CardView } from './CardView.js';
import { applyCardTheme } from './theme.js';
import { parseToolResult, type CardState } from './tool-result.js';

function PlanCardApp() {
  const [state, setState] = useState<CardState>({ kind: 'waiting' });
  const [theme, setTheme] = useState<McpUiHostContext['theme']>(undefined);

  const { app, error } = useApp({
    appInfo: { name: 'cold-reserve-plan-card', version: '0.0.0' },
    capabilities: {},
    onAppCreated: (created) => {
      created.ontoolresult = (result) => setState(parseToolResult(result));
      created.onhostcontextchanged = (ctx) => {
        if (ctx.theme) setTheme(ctx.theme);
      };
    },
  });

  useEffect(() => {
    const initial = app?.getHostContext()?.theme;
    if (initial) setTheme(initial);
  }, [app]);

  useEffect(() => {
    applyCardTheme(document.documentElement, theme, state.kind === 'plan' && state.plan.storm);
  }, [theme, state]);

  if (error) {
    return <CardView state={{ kind: 'error', message: 'The card could not reach the assistant.', retryable: true }} />;
  }
  return (
    <CardView
      state={state}
      onApply={() => {
        // Apply is out of scope for the spike: tell the host through the log channel.
        void app?.sendLog({ level: 'info', data: 'apply requested' });
      }}
    />
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<PlanCardApp />);
