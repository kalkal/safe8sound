import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CARD_KINDS, type CardKind } from '@cold-reserve/ui-cards';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCard } from '../agent/wire.js';
import { log } from '../log.js';
import { t } from '../ui/text.js';
import { useCardHost } from './card-host.js';
import { FrameTransport } from './frame-guard.js';
import { makeRestInert } from './inert.js';
import { answerCardCall, createFrameConfirmation } from './tool-calls.js';

// One MCP Apps card (plan §9.3–9.4): a sandboxed srcdoc iframe without allow-same-origin, the host's
// own CSP, every inbound message checked (FrameTransport), card tool calls checked (readToolCall) and
// answered by the agent. Spike S3 findings: initial hostContext in the constructor; the iframe
// color-scheme follows the card theme.

const HOST_INFO = { name: 'cold-reserve-alexa-sim', version: '0.1.0' };
const INITIAL_HEIGHT_PX = 360;
/** The modes this host can show a card in (#200): full screen only when the person asks for it. */
const DISPLAY_MODES: ('inline' | 'fullscreen')[] = ['inline', 'fullscreen'];

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
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const iframe = frameRef.current;
    const frame = iframe?.contentWindow;
    if (!iframe || !frame || !document.ok) return;
    // Card actions only when the agent can run them: the card hides Apply/Save otherwise.
    const capabilities = agent.canCallTools ? { serverTools: {}, logging: {} } : { logging: {} };
    const bridge = new AppBridge(null, HOST_INFO, capabilities, {
      hostContext: { ...contextRef.current, displayMode: 'inline', availableDisplayModes: DISPLAY_MODES },
    });
    bridge.addEventListener('initialized', () => {
      // A refused plan (#186) reaches the frame as what it is: an error result, with the guard's verdict.
      const refused = card.tool === 'plan_comfort' && !('id' in card.result);
      bridge.sendToolResult({ content: [], structuredContent: card.result, ...(refused ? { isError: true } : {}) }).catch((error: unknown) => {
        log({ level: 'error', code: 'unexpected_error', correlationId: turnId, error, details: { step: 'send_tool_result', card: card.tool } });
        setFailed(true);
      });
    });
    // The card asks; the host decides and answers with the mode it really set (MCP Apps).
    bridge.onrequestdisplaymode = ({ mode }) => {
      const next = mode === 'fullscreen' ? 'fullscreen' : 'inline';
      setFullscreen(next === 'fullscreen');
      return Promise.resolve({ mode: next });
    };
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
    bridgeRef.current?.setHostContext({ theme, timeZone, displayMode: fullscreen ? 'fullscreen' : 'inline', availableDisplayModes: DISPLAY_MODES });
  }, [theme, timeZone, fullscreen]);

  // Full screen: Escape on the page goes back too (inside the frame the card handles it), and focus follows
  // the frame in and back, so a keyboard user is never left behind the overlay.
  const shownMode = useRef(fullscreen);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only a change of mode moves focus: a frame that just appeared never takes it from the Ask box.
    // Focus already inside the frame (the card's own Back, by keyboard) stays where it is.
    if (shownMode.current !== fullscreen && window.document.activeElement !== frameRef.current) frameRef.current?.focus();
    shownMode.current = fullscreen;
    if (!fullscreen) return undefined;
    // A modal dialog: the rest of the page is inert until Back (#206 review).
    const restoreRest = hostRef.current === null ? undefined : makeRestInert(hostRef.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restoreRest?.();
    };
  }, [fullscreen]);

  if (!document.ok || failed) return <p role="alert">{t('surface.failed')}</p>;
  // The wrapper is always there, so the frame is never remounted (that would reload the card).
  return (
    <div
      ref={hostRef}
      className="card-frame-host"
      data-fullscreen={fullscreen}
      {...(fullscreen ? { role: 'dialog', 'aria-modal': true, 'aria-label': t(`cardFrame.${kind}`) } : {})}
    >
      <iframe
        ref={frameRef}
        className="card-frame"
        title={t(`cardFrame.${kind}`)}
        sandbox="allow-scripts"
        style={{ blockSize: fullscreen ? '100%' : `${String(height)}px`, colorScheme: theme }}
      />
    </div>
  );
}
