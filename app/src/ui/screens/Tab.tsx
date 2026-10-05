// The Tab screen (stories 5.6, 5.7; spine AD-3): the take's title, the analysis states, then its
// tab as one <pre> per system. It reads only its take session; nothing is handed over from
// Record. While analysing: "Analysing…", the bar with its percentage, and Cancel; after a
// cancel, Analyse; while the result is saved, "Saving…" with no Cancel. A failure shows one error banner, chosen by its code: the engine failed to
// load (Reload), storage full (a Library link and Retry, which saves the kept result), or
// Analysis failed (Retry). An analysed take with no notes shows "No notes found" and three tips.
//
// Story "Tab screen, reflow and selection" (US-6.2, US-6.3, US-8.2): the header (the title,
// renamed in place, the date and the duration), the "Skip to tab" link, the toolbar container
// (its buttons come later), the "Note list view" toggle, and the tab area (components/TabArea),
// which reflows to the window and carries the note selection. While mounted, the screen's
// session is the active take session the ← / → / Esc shortcuts act on.
// Warnings, the toolbar's buttons, the status line and playback come with later stories.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppErrorCode } from '../../model/errors';
import {
  setActiveTakeSession,
  activeTakeSession,
  type TakeAnalysisState,
  type TakeSession,
} from '../../session/take-session';
import { announce } from '../a11y/announcer';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { ErrorIcon } from '../components/icons';
import { noteLabels, TabArea } from '../components/TabArea';
import { TakeHeader } from '../components/TakeHeader';
import { reloadOrExplain } from '../reload-or-explain';
import { strings } from '../strings';
import { useTakeSession } from '../use-take-session';
import styles from './Screen.module.css';
import tabStyles from './Tab.module.css';

/** The tab area's element id: the skip link's target. */
const TAB_AREA_ID = 'tab-area';

/** Moves focus into the tab area: onto its note in the tab order (the selected, else the first). */
function focusTabArea() {
  document.getElementById(TAB_AREA_ID)?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
}

/** The whole percentage shown for a progress fraction (the epsilon absorbs float error). */
function percentOf(progress: number): number {
  return Math.floor(progress * 100 + 1e-9);
}

/**
 * Announces "Analysing, 25%" … "Analysing, 100%" politely as the run crosses each quarter, at
 * most once per quarter per run (EXPERIENCE.md Accessibility floor). A jump past several
 * quarters announces the highest only. A run ends when the state leaves `running`. Saving (a
 * commit, or a retried one) announces nothing.
 */
function useProgressAnnouncements(analysis: TakeAnalysisState) {
  const announced = useRef(0);
  const running = analysis.kind === 'running' && !analysis.saving;
  const quarter = running ? Math.min(4, Math.floor(percentOf(analysis.progress) / 25)) : 0;
  useEffect(() => {
    if (!running) {
      announced.current = 0;
      return;
    }
    if (quarter <= announced.current) return;
    announced.current = quarter;
    announce(strings['tab.analysingAnnounce'](quarter * 25));
  }, [running, quarter]);
}

/** The banner text for a failure code. */
function failureText(code: AppErrorCode): string {
  if (code === 'engine-unavailable') return strings['global.engineFailed'];
  if (code === 'storage-full') return strings['tab.storageFull'];
  return strings['tab.analysisFailed'];
}

/**
 * The error banner for a failed analysis, chosen by its code. Not a live region (spine AD-18):
 * it announces its text assertively through the shared announcer when it appears, as Record's
 * storage-full banner does.
 */
function FailureBanner({ code, session }: { code: AppErrorCode; session: TakeSession }) {
  const className = `${banner.banner} ${banner.error} ${tabStyles.banner}`;
  const text = failureText(code);
  // Once per banner shown (the ref survives StrictMode's effect re-run).
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === text) return;
    announced.current = text;
    announce(text, 'assertive');
  }, [text]);
  if (code === 'engine-unavailable') {
    return (
      <div className={className} data-testid="tab-engine-failed">
        <ErrorIcon className={banner.icon} />
        <p className={banner.text}>{text}</p>
        <button type="button" className={buttons.secondary} onClick={() => reloadOrExplain()}>
          {strings['global.reload']}
        </button>
      </div>
    );
  }
  if (code === 'storage-full') {
    return (
      <div className={className} data-testid="tab-storage-full">
        <ErrorIcon className={banner.icon} />
        <p className={banner.text}>{text}</p>
        <a className={tabStyles.link} href="#/library">
          {strings['tab.storageFullLibrary']}
        </a>
        <button type="button" className={buttons.secondary} onClick={() => session.retryCommit()}>
          {strings['tab.retry']}
        </button>
      </div>
    );
  }
  return (
    <div className={className} data-testid="tab-analysis-failed">
      <ErrorIcon className={banner.icon} />
      <p className={banner.text}>{text}</p>
      <button type="button" className={buttons.secondary} onClick={() => session.analyse()}>
        {strings['tab.retry']}
      </button>
    </div>
  );
}

export interface TabProps {
  takeId: string;
  /** Creates the screen's session; tests pass a mock. */
  createSession?: (takeId: string) => TakeSession;
}

export function Tab({ takeId, createSession }: TabProps) {
  const { snapshot, session } = useTakeSession(takeId, createSession);
  const { take, tab, analysis, missing, selectedNoteId } = snapshot;
  useProgressAnnouncements(analysis);
  const [noteList, setNoteList] = useState(false);
  const notes = tab?.notes;
  const labels = useMemo(() => (notes ? noteLabels(notes) : []), [notes]);

  // The shortcut registry reaches this session while the screen is mounted.
  useEffect(() => {
    setActiveTakeSession(session);
    return () => {
      if (activeTakeSession() === session) setActiveTakeSession(null);
    };
  }, [session]);

  // A state change can remove the focused control (Cancel, Analyse, Retry). Focus then moves to
  // the new state's primary button (Analyse after a cancel) or to the h1, never to <body>.
  // `focusInside` stays true when focus leaves to nothing, as when the focused control unmounts.
  const sectionRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const analyseButton = useRef<HTMLButtonElement>(null);
  const focusInside = useRef(false);
  const cancelled = analysis.kind === 'cancelled';
  const stateKey = `${analysis.kind}:${analysis.kind === 'running' && !!analysis.saving}:${
    analysis.kind === 'failed' ? analysis.code : ''
  }`;
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && sectionRef.current?.contains(active)) return;
    (analyseButton.current ?? titleRef.current)?.focus();
  }, [stateKey]);

  let body: ReactNode = null;
  if (missing) {
    body = <p className={tabStyles.message}>{strings['tab.notFound']}</p>;
  } else if (analysis.kind === 'running' && analysis.saving) {
    body = (
      <p className={tabStyles.message} data-testid="tab-saving">
        {strings['tab.saving']}
      </p>
    );
  } else if (analysis.kind === 'running') {
    const percent = strings['tab.analysingPercent'](percentOf(analysis.progress));
    body = (
      <div className={tabStyles.status}>
        <label className={tabStyles.label} htmlFor="tab-analysis-progress">
          {strings['tab.analysing']}
        </label>
        <div className={tabStyles.progressRow}>
          <progress
            id="tab-analysis-progress"
            className={tabStyles.progress}
            max={1}
            value={analysis.progress}
            aria-valuetext={percent}
          />
          <span className={tabStyles.percent} data-testid="tab-analysis-percent">
            {percent}
          </span>
          <button type="button" className={buttons.secondary} onClick={() => session.cancel()}>
            {strings['tab.cancel']}
          </button>
        </div>
      </div>
    );
  } else if (cancelled) {
    body = (
      <div className={tabStyles.status}>
        <button
          ref={analyseButton}
          type="button"
          className={buttons.secondary}
          onClick={() => session.analyse()}
        >
          {strings['tab.analyse']}
        </button>
      </div>
    );
  } else if (analysis.kind === 'idle' && tab && take && tab.notes.length === 0) {
    body = (
      <div className={tabStyles.noNotes} data-testid="tab-no-notes">
        <h2 className={tabStyles.noNotesTitle}>{strings['tab.noNotes']}</h2>
        <ul className={tabStyles.tips}>
          <li>{strings['tab.noNotesTipLevel']}</li>
          <li>{strings['tab.noNotesTipSingle']}</li>
          {/* Plain text until story 8.6 makes it a link to the Analysis settings panel. */}
          <li>{strings['tab.noNotesTipSensitivity']}</li>
        </ul>
      </div>
    );
  } else if (analysis.kind === 'idle' && tab && take && tab.notes.length > 0) {
    body = (
      <>
        <button
          type="button"
          className={`${buttons.secondary} ${buttons.toggle} ${tabStyles.noteListToggle}`}
          aria-pressed={noteList}
          onClick={() => setNoteList((on) => !on)}
        >
          {strings['tab.noteList']}
        </button>
        {noteList && (
          <ol className={tabStyles.noteList} data-testid="tab-note-list">
            {labels.map((l) => (
              <li key={l.id}>{l.label}</li>
            ))}
          </ol>
        )}
        <div className={tabStyles.systems}>
          <TabArea
            id={TAB_AREA_ID}
            notes={tab.notes}
            countInBpm={take.countInBpm}
            selectedNoteId={selectedNoteId}
            onSelect={(id) => session.select(id)}
          />
        </div>
      </>
    );
  }
  const showTab = !missing && analysis.kind === 'idle' && !!tab && !!take && tab.notes.length > 0;
  const showToolbar = !missing && analysis.kind === 'idle' && !!tab && !!take;

  return (
    <section
      ref={sectionRef}
      className={styles.screen}
      data-take-id={takeId}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next && !event.currentTarget.contains(next)) focusInside.current = false;
      }}
    >
      {showTab && (
        <a
          className={tabStyles.skipLink}
          href={`#/tab/${encodeURIComponent(takeId)}`}
          onClick={(event) => {
            event.preventDefault();
            focusTabArea();
          }}
        >
          {strings['tab.skipToTab']}
        </a>
      )}
      {!missing && analysis.kind === 'failed' && (
        <FailureBanner code={analysis.code} session={session} />
      )}
      <TakeHeader
        fallbackTitle={strings['tab.title']}
        take={missing ? null : take}
        onRename={(t) => void session.rename(t)}
        titleRef={titleRef}
      />
      {showToolbar && (
        <div className={tabStyles.toolbar} role="toolbar" aria-label={strings['tab.toolbar']} />
      )}
      {body}
    </section>
  );
}
