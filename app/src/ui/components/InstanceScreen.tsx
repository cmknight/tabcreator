import { useEffect, useRef, useSyncExternalStore } from 'react';
import { instanceLock, type InstanceState } from '../../session/instance-lock';
import { recordingSession, type HandoverTake } from '../../session/recording-session';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import styles from './InstanceScreen.module.css';

/** The states the instance screen shows: every one but `held` (the app) and `acquiring`. */
export type InstanceScreenState = Exclude<InstanceState, 'held' | 'acquiring'>;

function title(state: InstanceScreenState): string {
  switch (state) {
    case 'other-tab':
    case 'handing-over':
    case 'lost':
      return strings['global.instanceOtherTab'];
    case 'upgrade-blocked':
      return strings['global.instanceUpgradeBlocked'];
    case 'unsupported':
      return strings['global.unsupported'];
  }
}

/** The lost tab's line on what became of its take (story 5.3); null for no line. */
function takeLine(take: HandoverTake): string | null {
  if (take === 'saved') return strings['global.instanceTakeSaved'];
  if (take === 'failed') return strings['global.instanceTakeNotSaved'];
  return null;
}

const readHandoverTake = () => recordingSession.getSnapshot().handoverTake;

/**
 * The full-screen notice in place of the whole app shell while this tab does not run the app
 * (story 3.10, EXPERIENCE.md): "TabCreator is open in another tab" with "Use here" (disabled,
 * with a "Moving TabCreator here…" status line, while handing over), the update-blocked
 * notice, or the unsupported-browser notice. The heading takes focus when the notice appears.
 * In `lost`, a status line says what became of the take this tab was recording (story 5.3): it
 * may arrive after the notice, when the handover's save settles late.
 */
export function InstanceScreen({ state }: { state: InstanceScreenState }) {
  const text = title(state);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [text]);
  const handoverTake = useSyncExternalStore(recordingSession.subscribe, readHandoverTake);
  const line = state === 'lost' ? takeLine(handoverTake) : null;
  const handingOver = state === 'handing-over';
  const offersUseHere = state === 'other-tab' || state === 'lost' || handingOver;
  return (
    <main className={styles.screen}>
      <div>
        <span className={styles.appName}>{strings['global.appName']}</span>
        <h1 ref={heading} className={styles.title} tabIndex={-1}>
          {text}
        </h1>
        {state === 'lost' && (
          <p role="status" className={styles.take}>
            {line ?? ''}
          </p>
        )}
        {offersUseHere && (
          <div className={styles.actions}>
            <button
              type="button"
              className={buttons.primary}
              aria-disabled={handingOver ? 'true' : undefined}
              onClick={() => {
                if (!handingOver) instanceLock.useHere();
              }}
            >
              {strings['global.instanceUseHere']}
            </button>
            {/* A status region (polite), there before its text so the text is announced; the
                announcer (spine AD-18) lives in the app shell, which is not mounted here. */}
            <p role="status" className={styles.status}>
              {handingOver ? strings['global.instanceMovingHere'] : ''}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
