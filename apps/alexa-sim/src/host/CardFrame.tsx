import { toolError } from '@cold-reserve/contracts';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CARD_KINDS, type CardKind } from '@cold-reserve/ui-cards';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toolErrorResult } from '../agent/agent.js';
import type { ToolCard } from '../agent/wire.js';
import { t } from '../ui/text.js';
import { useCardHost } from './card-host.js';
import { FrameTransport } from './frame-guard.js';
import { readToolCall } from './tool-calls.js';

// One MCP Apps card (plan §9.3–9.4): a sandboxed srcdoc iframe without allow-same-origin, the host's
// own CSP, every inbound message checked (FrameTransport), card tool calls checked (readToolCall) and
// answered by the agent. Spike S3 findings: initial hostContext in the constructor; the iframe
// color-scheme follows the card theme.

const HOST_INFO = { name: 'cold-reserve-alexa-sim', version: '0.1.0' };
const INITIAL_HEIGHT_PX = 360;

export const kindOf = (tool: ToolCard['tool']): CardKind =>
  (Object.keys(CARD_KINDS) as CardKind[]).find((kind) => CARD_KINDS[kind].tool === tool) ?? 'plan';

export function CardFrame({ card }: { card: ToolCard }) {
  const { agent, documentFor, theme, timeZone } = useCardHost();
  const kind = kindOf(card.tool);
  const document = useMemo(() => documentFor(kind), [documentFor, kind]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const contextRef = useRef({ theme, timeZone });
  contextRef.current = { theme, timeZone };
  const [height, setHeight] = useState(INITIAL_HEIGHT_PX);

  useEffect(() => {
    const iframe = frameRef.current;
    const frame = iframe?.contentWindow;
    if (!iframe || !frame || !document.ok) return;
    // Card actions only when the agent can run them: the card hides Apply/Save otherwise.
    const capabilities = agent.canCallTools ? { serverTools: {}, logging: {} } : { logging: {} };
    const bridge = new AppBridge(null, HOST_INFO, capabilities, {
      hostContext: { ...contextRef.current, displayMode: 'inline', availableDisplayModes: ['inline'] },
    });
    bridge.addEventListener('initialized', () => {
      void bridge.sendToolResult({ content: [], structuredContent: card.result });
    });
    bridge.addEventListener('sizechange', ({ height: h }) => {
      if (typeof h === 'number' && h > 0) setHeight(Math.ceil(h));
    });
    bridge.oncalltool = async ({ name, arguments: args }) => {
      const call = readToolCall({ name, arguments: args }, card);
      if (!call.ok) return toolErrorResult(call.error);
      try {
        return await agent.callTool(call.value.name, call.value.args, { correlationId: crypto.randomUUID() });
      } catch (reason) {
        console.error(JSON.stringify({ level: 'error', component: 'alexa-sim', code: 'unexpected_error', tool: name, reason: String(reason) }));
        return toolErrorResult(toolError('unexpected_error', 'Something went wrong: nothing was changed.'));
      }
    };
    const transport = new FrameTransport(frame, window, (reason) => {
      console.warn(JSON.stringify({ level: 'warn', component: 'alexa-sim', code: 'frame_message_rejected', reason }));
    });
    bridgeRef.current = bridge;
    let closed = false;
    void bridge.connect(transport).then(() => {
      if (!closed) iframe.srcdoc = document.value;
    });
    return () => {
      closed = true;
      bridgeRef.current = null;
      void transport.close();
    };
  }, [agent, card, document]);

  useEffect(() => {
    bridgeRef.current?.setHostContext({ theme, timeZone, displayMode: 'inline', availableDisplayModes: ['inline'] });
  }, [theme, timeZone]);

  if (!document.ok) return <p role="alert">{t('surface.failed')}</p>;
  return (
    <iframe
      ref={frameRef}
      className="card-frame"
      title={t(`cardFrame.${kind}`)}
      sandbox="allow-scripts"
      style={{ blockSize: `${String(height)}px`, colorScheme: theme }}
    />
  );
}
