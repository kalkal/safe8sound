import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CARD_KINDS, type CardKind } from '@cold-reserve/ui-cards';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCard } from '../agent/wire.js';
import { log } from '../log.js';
import { t } from '../ui/text.js';
import { useCardHost } from './card-host.js';
import { FrameTransport } from './frame-guard.js';
import { answerCardCall, createFrameConfirmation } from './tool-calls.js';

// One MCP Apps card (plan §9.3–9.4): a sandboxed srcdoc iframe without allow-same-origin, the host's
// own CSP, every inbound message checked (FrameTransport), card tool calls checked (readToolCall) and
// answered by the agent. Spike S3 findings: initial hostContext in the constructor; the iframe
// color-scheme follows the card theme.

const HOST_INFO = { name: 'cold-reserve-alexa-sim', version: '0.1.0' };
const INITIAL_HEIGHT_PX = 360;

/** The card kind that shows a tool's result; a tool without a card has none (never another card's kind). */
export const kindOf = (tool: string): CardKind | undefined => (Object.keys(CARD_KINDS) as CardKind[]).find((kind) => CARD_KINDS[kind].tool === tool);

/** `turnId`: the turn that showed the card; its logs and its actions carry that correlation id. */
export function CardFrame({ card, turnId }: { card: ToolCard; turnId: string }) {
  const kind = kindOf(card.tool);
  if (kind === undefined) {
    log({ level: 'warn', code: 'unknown_card', correlationId: turnId, details: { card: card.tool } });
    return <p role="alert">{t('card.failed')}</p>;
  }
  return <KnownCardFrame card={card} kind={kind} turnId={turnId} />;
}

function KnownCardFrame({ card, kind, turnId }: { card: ToolCard; kind: CardKind; turnId: string }) {
  const { agent, documentFor, theme, timeZone } = useCardHost();
  const document = useMemo(() => documentFor(kind), [documentFor, kind]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const contextRef = useRef({ theme, timeZone });
  contextRef.current = { theme, timeZone };
  const [height, setHeight] = useState(INITIAL_HEIGHT_PX);
  const [failed, setFailed] = useState(false);

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
      // A refused plan (#186) reaches the frame as what it is: an error result, with the guard's verdict.
      const refused = card.tool === 'plan_comfort' && !('id' in card.result);
      bridge.sendToolResult({ content: [], structuredContent: card.result, ...(refused ? { isError: true } : {}) }).catch((error: unknown) => {
        log({ level: 'error', code: 'unexpected_error', correlationId: turnId, error, details: { step: 'send_tool_result', card: card.tool } });
        setFailed(true);
      });
    });
    bridge.addEventListener('sizechange', ({ height: h }) => {
      if (typeof h === 'number' && h > 0) setHeight(Math.ceil(h));
    });
    // Each frame keeps its own last-resort confirmation: a token never crosses frames.
    const confirmation = createFrameConfirmation();
    bridge.oncalltool = ({ name, arguments: args }) => answerCardCall({ name, arguments: args }, card, { agent, turnId, log, confirmation });
    const transport = new FrameTransport(frame, window, (reason) => {
      log({ level: 'warn', code: 'frame_message_rejected', correlationId: turnId, details: { reason, card: card.tool } });
    });
    bridgeRef.current = bridge;
    let closed = false;
    bridge
      .connect(transport)
      .then(() => {
        if (!closed) iframe.srcdoc = document.value;
      })
      .catch((error: unknown) => {
        log({ level: 'error', code: 'unexpected_error', correlationId: turnId, error, details: { step: 'connect', card: card.tool } });
        if (!closed) setFailed(true);
      });
    return () => {
      closed = true;
      bridgeRef.current = null;
      void transport.close();
    };
  }, [agent, card, document, turnId]);

  useEffect(() => {
    bridgeRef.current?.setHostContext({ theme, timeZone, displayMode: 'inline', availableDisplayModes: ['inline'] });
  }, [theme, timeZone]);

  if (!document.ok || failed) return <p role="alert">{t('surface.failed')}</p>;
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
