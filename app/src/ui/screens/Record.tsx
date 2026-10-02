import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { InputQualityBanner } from '../components/InputQualityBanner';
import { LevelMeter } from '../components/LevelMeter';
import { MicSelect } from '../components/MicSelect';
import { micErrorCode, type MicErrorCode } from '../mic-error';
import { strings } from '../strings';
import styles from './Screen.module.css';
import recordStyles from './Record.module.css';

/** Marks the element that takes focus when the card or level meter replaces what had it. */
const FOCUS_TARGET = 'data-focus-target';

export function Record() {
  const { mic, errorCode: code } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const errorCode = mic === 'live' ? null : micErrorCode(code);
  const view = mic === 'live' ? 'live' : (errorCode ?? 'setup');

  useEffect(() => {
    void recordingSession.resume();
  }, []);

  // When the view swaps while focus is inside it (Allow fails, Try again succeeds), the focused
  // button goes and focus would fall to <body>: move it to the new card's heading or the meter.
  const area = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  const shownView = useRef(view);
  useLayoutEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    const active = document.activeElement;
    if (!focusInside.current || (active !== null && active !== document.body)) return;
    area.current?.querySelector<HTMLElement>(`[${FOCUS_TARGET}]`)?.focus();
  }, [view]);

  return (
    <section className={styles.screen}>
      {/* First, above the h1 (mockup order); it renders only while the mic is live. */}
      <InputQualityBanner />
      <h1 className={styles.title} tabIndex={-1}>
        {strings['record.title']}
      </h1>
      <div
        ref={area}
        onFocus={() => (focusInside.current = true)}
        onBlur={(e) => {
          // A removed element blurs with no relatedTarget: that is the swap, not focus leaving.
          const to = e.relatedTarget;
          if (to && !e.currentTarget.contains(to)) focusInside.current = false;
        }}
      >
        {mic === 'live' ? (
          <>
            <MicSelect />
            <LevelMeter />
          </>
        ) : (
          <MicSetupCard requesting={mic === 'requesting'} errorCode={errorCode} />
        )}
      </div>
    </section>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg className={recordStyles.setupIcon} viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d={`M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7${off ? 'M4 4l16 16' : ''}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The mic setup card, or its error variant (mockup record.html (c)): danger edge, mic-off icon,
 * the code's heading, one sentence, numbered steps and Try again. The error heading is announced
 * by `MicErrorAnnouncer` in the shell, so the card itself is not a live region (AD-18). While a
 * request runs the button is `aria-disabled`, not `disabled`, so it keeps focus.
 */
function MicSetupCard({
  requesting,
  errorCode,
}: {
  requesting: boolean;
  errorCode: MicErrorCode | null;
}) {
  if (errorCode) {
    const key = `record.micError.${errorCode}` as const;
    return (
      <section
        className={`${recordStyles.setup} ${recordStyles.error}`}
        aria-labelledby="mic-setup-title"
        data-error-code={errorCode}
      >
        <MicIcon off />
        <h2
          id="mic-setup-title"
          className={recordStyles.setupTitle}
          tabIndex={-1}
          data-focus-target=""
        >
          {strings[`${key}.title`]}
        </h2>
        <p className={recordStyles.setupText}>{strings[`${key}.body`]}</p>
        <ol className={recordStyles.steps}>
          <li>{strings[`${key}.step1`]}</li>
          <li>{strings[`${key}.step2`]}</li>
          <li>{strings[`${key}.step3`]}</li>
        </ol>
        <div className={recordStyles.actions}>
          <button
            type="button"
            className={recordStyles.primary}
            aria-disabled={requesting || undefined}
            onClick={() => {
              if (!requesting) void recordingSession.allowMic();
            }}
          >
            {strings['record.tryAgain']}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className={recordStyles.setup} aria-labelledby="mic-setup-title">
      <MicIcon off={false} />
      <h2
        id="mic-setup-title"
        className={recordStyles.setupTitle}
        tabIndex={-1}
        data-focus-target=""
      >
        {strings['record.micSetupTitle']}
      </h2>
      <p className={recordStyles.setupText}>{strings['record.micSetupText']}</p>
      <button
        type="button"
        className={recordStyles.primary}
        aria-disabled={requesting || undefined}
        onClick={() => {
          if (!requesting) void recordingSession.allowMic();
        }}
      >
        {strings['record.allowMic']}
      </button>
    </section>
  );
}
