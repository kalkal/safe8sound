import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { TempUnit } from '@cold-reserve/contracts';
import { CARD_KINDS, CARD_WAITING_MIN_PX, DEMO_CONTEXT_KEY, UNITS_CONTEXT_KEY, type CardKind } from '@cold-reserve/ui-cards';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, type Locale } from '@cold-reserve/i18n';
import type { ToolCard } from '../agent/wire.js';
import { log } from '../log.js';
import { t } from '../ui/text.js';
import { useCardHost } from './card-host.js';
import { FrameTransport } from './frame-guard.js';
import { makeRestInert } from './inert.js';
import { answerCardCall, confirmationFor } from './tool-calls.js';

// One MCP Apps card (plan §9.3–9.4): a sandboxed srcdoc iframe without allow-same-origin, the host's
// own CSP, every inbound message checked (FrameTransport), card tool calls checked (readToolCall) and
// answered by the agent. Spike S3 findings: initial hostContext in the constructor; the iframe
// color-scheme follows the card theme.

const HOST_INFO = { name: 'cold-reserve-alexa-sim', version: '0.1.0' };
/** The card keeps this height while it waits for its result (ui-cards), so the frame never shrinks and grows back. */
const INITIAL_HEIGHT_PX = CARD_WAITING_MIN_PX;
/** A landscape Echo screen, as in app.css: there the cards fit the content band. */
const ECHO_LANDSCAPE = '(width >= 56rem)';
/** The modes this host can show a card in (#200): full screen only when the person asks for it. */
const DISPLAY_MODES: ('inline' | 'fullscreen')[] = ['inline', 'fullscreen'];

/** The hostContext of a frame: the MCP Apps fields, plus the simulator's own demo key only in demo mode. */
export function hostContextFor({ theme, timeZone, fullscreen, demo, locale, units = 'C', maxHeight }: { theme: 'dark' | 'light'; timeZone: string; fullscreen: boolean; demo: boolean; locale: Locale; units?: TempUnit; maxHeight?: number }) {
  return {
    // No scrolling on the Echo screen (owner, 10 Oct): inline, the height the card has; the card fits itself in it.
    ...(maxHeight === undefined ? {} : { containerDimensions: { maxHeight } }),
    theme,
    timeZone,
    // #263: the page's language, through the standard MCP Apps field.
    locale,
    displayMode: fullscreen ? ('fullscreen' as const) : ('inline' as const),
    availableDisplayModes: DISPLAY_MODES,
    ...(demo ? { [DEMO_CONTEXT_KEY]: true } : {}),
    // °F everywhere (owner decision, 9 Oct): always said, so a switch back to °C reaches a card already shown;
    // a host that never names it (a real Alexa+ device) gets the cards' default, °C.
    [UNITS_CONTEXT_KEY]: units,
  };
}

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
  const { agent, documentFor, theme, timeZone, demo = false, units = 'C', onCardAction } = useCardHost();
  const onCardActionRef = useRef(onCardAction);
  onCardActionRef.current = onCardAction;
  const document = useMemo(() => documentFor(kind), [documentFor, kind]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const contextRef = useRef<{ theme: 'dark' | 'light'; timeZone: string; demo: boolean; locale: Locale; units: TempUnit; maxHeight?: number }>({ theme, timeZone, demo, locale, units });
  contextRef.current = { theme, timeZone, demo, locale, units };
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
      hostContext: hostContextFor({ ...contextRef.current, fullscreen: false }),
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
    const confirmation = confirmationFor(card);
    bridge.oncalltool = async ({ name, arguments: args }) => {
      const result = await answerCardCall({ name, arguments: args }, card, { agent, turnId, log, confirmation });
      if (result.isError !== true) onCardActionRef.current?.(name, turnId, result.structuredContent);
      return result;
    };
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

  // No scrolling on the Echo screen (owner, 10 Oct): inline, the room left in the content band below this frame. On a
  // phone (narrower than a landscape Echo) the band scrolls like a page instead, so the 48 px targets stay 48 px.
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const host = hostRef.current;
    const band = host?.closest('.band-content');
    if (!host || !band) return undefined;
    const echo = window.matchMedia(ECHO_LANDSCAPE);
    const measure = () => {
      // On a phone, or behind its tab (not laid out): no limit; it is measured when it shows.
      if (!echo.matches || host.offsetParent === null) {
        setRoom(Number.POSITIVE_INFINITY);
        return;
      }
      const bandBox = band.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      // What the band holds below this frame (the answer box's padding and border): the frame leaves room for it.
      // Measured from the band's content, never from its scroll height (equal to its own height when all fits).
      const contentBottom = Math.max(...Array.from(band.children, (child) => child.getBoundingClientRect().bottom));
      const below = Math.max(0, contentBottom - hostBox.bottom);
      setRoom(Math.floor(bandBox.bottom - hostBox.top - below));
    };
    echo.addEventListener('change', measure);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        echo.removeEventListener('change', measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    // A card shown again by its tab gets its size back, and what sits above it (the answer's words, the tabs) can
    // change height after a font loads: measured then too.
    observer.observe(host);
    for (const above of band.querySelectorAll(':scope > *, .answer > *, .tool-cards > *')) observer.observe(above);
    return () => {
      echo.removeEventListener('change', measure);
      observer.disconnect();
    };
  }, []);
  // MCP Apps containerDimensions: the card fits itself in this height (inline only; full screen is the whole screen).
  const maxHeight = fullscreen || !Number.isFinite(room) ? undefined : Math.max(0, room);
  // Also in the first hostContext: a frame measured before its bridge connected (a card behind its tab) still fits.
  if (maxHeight !== undefined) contextRef.current.maxHeight = maxHeight;
  useEffect(() => {
    bridgeRef.current?.setHostContext(hostContextFor({ theme, timeZone, fullscreen, demo, locale, units, ...(maxHeight === undefined ? {} : { maxHeight }) }));
  }, [theme, timeZone, fullscreen, demo, locale, units, maxHeight]);

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
        style={{
          // Never taller than the room in the band, even while the card waits or before it fits itself.
          blockSize: fullscreen ? '100%' : `${String(Math.min(height, maxHeight ?? height))}px`,
          colorScheme: theme,
        }}
      />
    </div>
  );
}
