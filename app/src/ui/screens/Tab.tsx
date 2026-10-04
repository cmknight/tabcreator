// The Tab screen (story 5.6, spine AD-3): the take's title, a progress bar while it is analysed,
// then its tab as one <pre> per system. It reads only its take session; nothing is handed over
// from Record. Cancel, Retry, warnings, selection, reflow and playback come with stories 5.7–5.10.

import { layoutTab } from '../../model/tab-render';
import type { TakeSession } from '../../session/take-session';
import { strings } from '../strings';
import { useTakeSession } from '../use-take-session';
import styles from './Screen.module.css';
import tabStyles from './Tab.module.css';

/** The fixed text width of a system until reflow (story 5.8). */
const TAB_WIDTH = 80;

export interface TabProps {
  takeId: string;
  /** Creates the screen's session; tests pass a mock. */
  createSession?: (takeId: string) => TakeSession;
}

export function Tab({ takeId, createSession }: TabProps) {
  const { take, tab, analysis, missing } = useTakeSession(takeId, createSession);
  const title = take?.title ?? strings['tab.title'];
  const systems = tab && take ? layoutTab(tab.notes, TAB_WIDTH, take.countInBpm).systems : [];

  return (
    <section className={styles.screen} data-take-id={takeId}>
      <h1 className={styles.title}>{missing ? strings['tab.title'] : title}</h1>
      {missing ? (
        <p className={tabStyles.message}>{strings['tab.notFound']}</p>
      ) : analysis.kind === 'running' ? (
        <div className={tabStyles.status}>
          <label className={tabStyles.label} htmlFor="tab-analysis-progress">
            {strings['tab.analysing']}
          </label>
          <progress
            id="tab-analysis-progress"
            className={tabStyles.progress}
            max={1}
            value={analysis.progress}
          />
        </div>
      ) : analysis.kind === 'failed' ? (
        <p className={tabStyles.message} data-testid="tab-analysis-failed">
          {strings['tab.analysisFailed']}
        </p>
      ) : (
        systems.length > 0 && (
          <div className={tabStyles.systems} data-testid="tab-systems">
            {systems.map((system, i) => (
              // tabIndex: a system wider than the screen scrolls, and keyboard users can scroll it.
              <pre key={i} className={tabStyles.system} tabIndex={0}>
                {system.lines.join('\n')}
              </pre>
            ))}
          </div>
        )
      )}
    </section>
  );
}
