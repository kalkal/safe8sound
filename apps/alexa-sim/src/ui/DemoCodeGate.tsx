import { useState, type SyntheticEvent } from 'react';
import type { ErrorCode } from '@cold-reserve/contracts';
import type { DemoSession } from '../agent/demo-session.js';
import { t } from './text.js';

/** What the gate says about a failed exchange, in plain words (reviews of #101 and #140). */
function problemText(code: ErrorCode): string {
  if (code === 'invalid_demo_code') return t('demo.invalid');
  if (code === 'demo_quota_exceeded') return t('demo.tooMany');
  if (code === 'demo_disabled') return t('demo.disabled');
  return t('demo.unreachable');
}

/**
 * The demo code field of remote mode (#101, main's decision): shown only without a token, a large input
 * with a show/hide toggle, no autocomplete, never stored; the field is emptied right after the exchange.
 * Why the gate is back (expired, refused) is read out by a live region that is always on the page.
 */
export function DemoCodeGate({ session }: { session: DemoSession }) {
  const [code, setCode] = useState('');
  const [visible, setVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Start stays enabled (so it keeps the focus): an empty field or a pending check does nothing.
    if (busy || code.length === 0) return;
    const entered = code;
    setCode(''); // the code leaves the UI state at once; only the token is kept, in memory
    setBusy(true);
    void session.start(entered).then((result) => {
      setBusy(false);
      setProblem(result.ok ? null : problemText(result.error.code));
    });
  };

  const why = problem !== null ? '' : session.expired() ? t('demo.expired') : session.refused() ? t('demo.again') : '';

  return (
    <form className="ask demo-gate" onSubmit={onSubmit}>
      <p className="demo-expired" role="status">
        {why}
      </p>
      {problem !== null && (
        <p className="failure" role="alert">
          {problem}
        </p>
      )}
      <label htmlFor="demo-code">{t('demo.label')}</label>
      <div className="ask-row">
        <input
          id="demo-code"
          className="demo-code"
          name="demo-code"
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
        />
        <button
          type="button"
          className="link-button"
          aria-pressed={visible}
          onClick={() => {
            setVisible((v) => !v);
          }}
        >
          {t(visible ? 'demo.hide' : 'demo.show')}
        </button>
        <button type="submit" className="button" aria-disabled={busy || code.length === 0}>
          {t('demo.start')}
        </button>
      </div>
      {/* The CloudFront access logs keep the visitor's IP for 30 days (K1, #244): said before anything is sent. */}
      <p className="notice">{t('demo.privacy')}</p>
    </form>
  );
}
