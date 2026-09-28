import { AppBridge, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { useEffect, useRef, useState } from 'react';
import { buildCardCsp, injectCsp, type CardCspMeta } from './card-csp.js';
import { FrameTransport, type RejectReason } from './frame-guard.js';

type Scenario = 'hot-day' | 'storm' | 'home-unreachable';
type Theme = 'dark' | 'light';

interface Loaded {
  html: string;
  result: CallToolResult;
  args: { scenario: Scenario };
}

const TOOL = 'plan_comfort';

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'cold-reserve-s3-host', version: '0.0.0' });
  // Cast: the SDK's own transport does not satisfy its Transport type under exactOptionalPropertyTypes (sessionId).
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin)) as Transport);
  return client;
}

async function loadCard(client: Client, scenario: Scenario): Promise<Loaded> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === TOOL);
  const uri = tool ? getToolUiResourceUri(tool) : undefined;
  if (!uri) throw new Error(`${TOOL} has no ui:// resource`);
  const args = { scenario };
  const [result, resource] = await Promise.all([
    client.callTool({ name: TOOL, arguments: args }) as Promise<CallToolResult>,
    client.readResource({ uri }),
  ]);
  const content = resource.contents[0];
  if (!content || !('text' in content)) throw new Error(`${uri} returned no HTML`);
  const csp = (content._meta?.['ui'] as { csp?: CardCspMeta } | undefined)?.csp;
  const html = injectCsp(content.text, buildCardCsp(csp));
  if (!html.ok) throw new Error(`${uri} has no <head>: refusing to render it without a CSP`);
  return { html: html.value, result, args };
}

export function HostApp() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [scenario, setScenario] = useState<Scenario>('hot-day');
  const [problem, setProblem] = useState<string | null>(null);
  const [rejected, setRejected] = useState<RejectReason[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [height, setHeight] = useState(480);

  const clientRef = useRef<Client | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const transportRef = useRef<FrameTransport | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Load the card once; later scenarios reuse the same iframe and bridge (tool result only).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await connectClient();
        clientRef.current = client;
        const loaded = await loadCard(client, 'hot-day');
        const frame = iframeRef.current?.contentWindow;
        if (cancelled || !frame || !iframeRef.current) return;

        // Initial context goes in the options: setHostContext() before connect() rejects "Not connected" unhandled.
        const bridge = new AppBridge(
          null,
          { name: 'cold-reserve-s3-host', version: '0.0.0' },
          { logging: {} },
          { hostContext: { theme: themeRef.current, displayMode: 'inline', availableDisplayModes: ['inline'] } },
        );
        bridge.oninitialized = () => {
          void bridge.sendToolInput({ arguments: loaded.args });
          void bridge.sendToolResult(loaded.result);
        };
        bridge.onsizechange = ({ height: h }) => {
          if (typeof h === 'number' && h > 0) setHeight(Math.ceil(h));
        };
        bridge.onloggingmessage = ({ data }) => setLogs((l) => [...l, String(data)]);
        const transport = new FrameTransport(frame, window, (reason) => setRejected((r) => [...r, reason]));
        await bridge.connect(transport);
        transportRef.current = transport;
        bridgeRef.current = bridge;
        iframeRef.current.srcdoc = loaded.html;
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void transportRef.current?.close();
    };
  }, []);

  useEffect(() => {
    bridgeRef.current?.setHostContext({ theme, displayMode: 'inline', availableDisplayModes: ['inline'] });
  }, [theme]);

  async function runScenario(next: Scenario) {
    setScenario(next);
    const client = clientRef.current;
    const bridge = bridgeRef.current;
    if (!client || !bridge) return;
    try {
      const result = (await client.callTool({ name: TOOL, arguments: { scenario: next } })) as CallToolResult;
      await bridge.sendToolInput({ arguments: { scenario: next } });
      await bridge.sendToolResult(result);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="host" data-host-theme={theme}>
      <h1>S3 host · MCP Apps card</h1>
      <div className="controls">
        <fieldset>
          <legend>Card theme (hostContext.theme)</legend>
          {(['dark', 'light'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
              {t}
            </button>
          ))}
        </fieldset>
        <fieldset>
          <legend>Scenario (tool argument)</legend>
          {(['hot-day', 'storm', 'home-unreachable'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scenario === s} onClick={() => void runScenario(s)}>
              {s}
            </button>
          ))}
        </fieldset>
      </div>
      {problem && <p role="alert">{problem}</p>}
      <div className="card-slot">
        <iframe ref={iframeRef} title="Plan card" sandbox="allow-scripts" style={{ height, colorScheme: theme }} />
      </div>
      <dl className="diagnostics">
        <dt>Rejected messages</dt>
        <dd data-testid="rejected-count">{rejected.length}</dd>
        <dt>Reasons</dt>
        <dd data-testid="rejected-reasons">{rejected.join(', ') || '—'}</dd>
        <dt>Card log</dt>
        <dd data-testid="card-log">{logs.join(', ') || '—'}</dd>
      </dl>
    </main>
  );
}
