import { useApp, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/react';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isLocale, setLocale } from '@cold-reserve/i18n';
import { installTapMarks, isDemoContext } from '../demo-taps.js';
import { placeOfContext, setPlace } from '../place-context.js';
import { setTempUnit, unitOfContext } from '../temp-unit.js';
import { cardThemeFor } from '../theme.js';
import { ACTION_CONTEXT_KEY, actionOfContext, type CardAction } from '../card-action.js';
import { CardApp } from './CardApp.js';
import { afterCall } from './card-calls.js';
import { CardFailed } from './CardErrorBoundary.js';
import { log, logUnhandled } from './card-log.js';
import { isCardKind, isStormState, parseCardResult, safeTimeZone, type CardKind, type CardState } from './card-kinds.js';

// Entry of the ui:// card bundle. The document names its card (data-card); the host sends the tool
// result and the context (theme, time zone) through the MCP Apps bridge. Covered by the host e2e tests.

type Context = Pick<McpUiHostContext, 'theme' | 'timeZone' | 'displayMode' | 'availableDisplayModes' | 'locale' | 'containerDimensions'>;

function Card({ kind }: { kind: CardKind }) {
  const [state, setState] = useState<CardState>({ kind: 'waiting' });
  const stateRef = useRef(state);
  stateRef.current = state;
  // Where this frame's action stands (busy, applied, expired): the host says it, the card keeps none of its own.
  const [action, setAction] = useState<CardAction>({ phase: 'ready' });
  const [context, setContext] = useState<Context>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  // Demo mode for the video: only the simulator sets it; the card then marks each tap inside its frame.
  const [demo, setDemo] = useState(false);
  // °F everywhere (owner decision, 9 Oct): the unit the host names; °C when it names none. Kept in state so the card redraws.
  const [units, setUnits] = useState<'C' | 'F'>('C');
  // #376: the place the host names (the number to call on a last resort); kept in state so the card redraws.
  const [place, setPlaceState] = useState<ReturnType<typeof placeOfContext>>(undefined);

  const { app, error } = useApp({
    appInfo: { name: 'cold-reserve-cards', version: '0.1.0' },
    // The card can be shown inline or full screen (#200); the host decides which it offers.
    capabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    onAppCreated: (created) => {
      created.addEventListener('toolresult', (result) => {
        setState(parseCardResult(kind, result));
      });
      created.addEventListener('hostcontextchanged', (changed) => {
        const { theme, timeZone, displayMode, availableDisplayModes, locale, containerDimensions } = changed;
        // #263: the card speaks the host's language (standard hostContext.locale); English otherwise.
        if (isLocale(locale)) setLocale(locale);
        if (isDemoContext(changed)) setDemo(true);
        if (ACTION_CONTEXT_KEY in changed) setAction(actionOfContext(changed));
        const named = placeOfContext(changed);
        if (named !== undefined) {
          setPlace(named);
          setPlaceState(named);
        }
        const unit = unitOfContext(changed);
        if (unit !== undefined) {
          setTempUnit(unit);
          setUnits(unit);
        }
        setContext((previous) => ({
          ...previous,
          ...(theme !== undefined && { theme }),
          ...(timeZone !== undefined && { timeZone }),
          ...(displayMode !== undefined && { displayMode }),
          ...(availableDisplayModes !== undefined && { availableDisplayModes }),
          ...(locale !== undefined && { locale }),
          ...(containerDimensions !== undefined && { containerDimensions }),
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
        ...(initial.locale !== undefined && { locale: initial.locale }),
        ...(initial.containerDimensions !== undefined && { containerDimensions: initial.containerDimensions }),
      });
      if (isLocale(initial.locale)) setLocale(initial.locale);
      setDemo(isDemoContext(initial));
      setAction(actionOfContext(initial));
      const named = placeOfContext(initial);
      setPlace(named);
      setPlaceState(named);
      const unit = unitOfContext(initial) ?? 'C';
      setTempUnit(unit);
      setUnits(unit);
    }
  }, [app]);

  useEffect(() => (demo ? installTapMarks(document) : undefined), [demo]);

  useEffect(() => {
    document.documentElement.dataset['units'] = units;
  }, [units]);

  useEffect(() => {
    if (place === undefined) delete document.documentElement.dataset['place'];
    else document.documentElement.dataset['place'] = place;
  }, [place]);

  useEffect(() => {
    document.documentElement.dataset['cardTheme'] = cardThemeFor(context.theme);
  }, [context.theme]);

  // Screen readers read the card in its language (#263).
  useEffect(() => {
    if (isLocale(context.locale)) document.documentElement.lang = context.locale.slice(0, 2);
  }, [context.locale]);

  useEffect(() => {
    document.documentElement.classList.toggle('theme-storm', isStormState(state));
  }, [state]);

  // Full screen for the whole frame, only through the host and only when it offers it (#200).
  const fullscreen = context.displayMode === 'fullscreen';
  // The styles keep the big numbers at full size in full screen (#398).
  useEffect(() => {
    document.documentElement.toggleAttribute('data-fullscreen', fullscreen);
  }, [fullscreen]);
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

  const display = { canFullscreen: context.availableDisplayModes?.includes('fullscreen') === true, fullscreen, toggle: toggleDisplay };

  // Still a card with its title row (#356): a frame in full screen keeps "Back" and Escape.
  if (error) return <CardFailed display={display} />;
  return (
    <CardApp
      state={state}
      timeZone={safeTimeZone(context.timeZone)}
      canAct={app?.getHostCapabilities()?.serverTools !== undefined}
      // No scrolling on the Echo screen (owner, 10 Oct): inline, the height the host gives this frame.
      {...(fullscreen ? {} : { maxHeight: maxHeightOf(context.containerDimensions) })}
      display={display}
      {...(notice !== undefined && { notice })}
      action={action}
      onCallTool={async (name, args) => {
        if (app === null) return;
        const result = await app.callServerTool({ name, arguments: args }).catch((error: unknown) => {
          log({ level: 'warn', code: 'unexpected_error', error, details: { tool: name } });
          return undefined;
        });
        // A failed call keeps the card and its buttons, with one line saying what went wrong (card-calls).
        const next = afterCall(stateRef.current, name, result);
        setState(next.state);
        setNotice(next.notice);
      }}
    />
  );
}

/** MCP Apps containerDimensions: a fixed height or a maximum one; none when the host gives neither. */
function maxHeightOf(dimensions: Context['containerDimensions']): number | undefined {
  if (dimensions === undefined) return undefined;
  if ('maxHeight' in dimensions && typeof dimensions.maxHeight === 'number') return dimensions.maxHeight;
  if ('height' in dimensions && typeof dimensions.height === 'number') return dimensions.height;
  return undefined;
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
