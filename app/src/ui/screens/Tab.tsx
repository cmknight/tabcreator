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
//
// Story "Flags, warnings and bar lines on screen": the warning banners (components/TakeWarnings),
// the status line with Next to check (components/TabStatusLine), the flagged notes, the "Maximum
// length reached" toast, and the toolbar's Bar lines toggle (`prefs.barLines` through
// settings-session). The other toolbar buttons come with later stories.
//
// Story "Playback with a following cursor": the playback group (components/PlaybackControls,
// state in ui/use-playback.ts) between the status line and the tab, shown with the tab. The
// playing note is outlined in the tab area; a click on a note while playing seeks to it. While
// shown, its controller is the active playback the Space and `P` shortcuts act on.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AppErrorCode } from '../../model/errors';
import type { Take } from '../../model/types';
import { activePlayback, setActivePlayback } from '../../session/playback';
import { settingsSession, type SettingsSession } from '../../session/settings-session';
import {
  setActiveTakeSession,
  activeTakeSession,
  isTabShown,
  type TakeAnalysisState,
  type TakeSession,
  type TakeSnapshot,
} from '../../session/take-session';
import { announce } from '../a11y/announcer';
import { focusSelectedNote } from '../a11y/shortcuts';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { BarLinesIcon, ErrorIcon } from '../components/icons';
import { StorageFullBannerView } from '../components/StorageFullBannerView';
import { PlaybackControls } from '../components/PlaybackControls';
import { noteLabels, TabArea } from '../components/TabArea';
import { TabStatusLine } from '../components/TabStatusLine';
import { TakeHeader } from '../components/TakeHeader';
import { TakeWarnings, type DismissibleWarning } from '../components/TakeWarnings';
import { reloadOrExplain } from '../reload-or-explain';
import { strings } from '../strings';
import { showToast } from '../toast';
import { usePlayback } from '../use-playback';
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
      <StorageFullBannerView
        text={text}
        className={tabStyles.banner}
        testId="tab-storage-full"
        retry={{ label: strings['tab.retry'], onClick: () => session.retryCommit() }}
      />
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
  /** The settings store the Bar lines toggle reads and writes; tests pass their own. */
  settings?: Pick<SettingsSession, 'subscribePrefs' | 'getSnapshot' | 'setBarLines'>;
  /** Reads the take's compressed audio for playback; tests pass their own. */
  readAudio?: (takeId: string) => Promise<Blob | null>;
}

/**
 * "Maximum length reached" once per screen visit, when the take first loads `recorded` with
 * `stopReason` `max-length`: the open straight after its auto-stop, before analysis committed
 * (spine AD-14: derived from persisted fields, no handoff). A later open finds it `analyzed`.
 */
function useMaxLengthToast(take: TakeSnapshot['take']) {
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !take) return;
    checked.current = true;
    // Written moments ago: a take left `recorded` (analysis cancelled, failed or interrupted)
    // and reopened later does not toast again.
    const fresh = Date.now() - Date.parse(take.updatedAt) < MAX_LENGTH_TOAST_WINDOW_MS;
    if (take.stopReason === 'max-length' && take.status === 'recorded' && fresh) {
      showToast({ message: strings['tab.maxLengthReached'] });
    }
  }, [take]);
}

/** How recently a max-length take must have been written for its open to toast. */
export const MAX_LENGTH_TOAST_WINDOW_MS = 30_000;

/** No warning dismissed. */
const NONE_DISMISSED: ReadonlySet<DismissibleWarning> = new Set();

export function Tab({ takeId, createSession, settings = settingsSession, readAudio }: TabProps) {
  const { snapshot, session } = useTakeSession(takeId, createSession);
  const { take, tab, analysis, missing, selectedNoteId } = snapshot;
  useProgressAnnouncements(analysis);
  useMaxLengthToast(missing ? null : take);
  const { barLines } = useSyncExternalStore(settings.subscribePrefs, settings.getSnapshot).prefs;
  const [noteList, setNoteList] = useState(false);
  /**
   * Warnings dismissed on this visit (never persisted: they return when the take reopens), for
   * the `warnings` they were dismissed on: a re-analysis replaces those, which shows them again.
   */
  const [dismissedFor, setDismissedFor] = useState<{
    warnings: Take['warnings'];
    kinds: ReadonlySet<DismissibleWarning>;
  }>({ warnings: undefined, kinds: NONE_DISMISSED });
  const dismissed = dismissedFor.warnings === take?.warnings ? dismissedFor.kinds : NONE_DISMISSED;
  /** The status line last shown on this visit (see TabStatusLine). */
  const lastStatusLine = useRef<string | null>(null);
  const notes = tab?.notes;
  const labels = useMemo(() => (notes ? noteLabels(notes) : []), [notes]);
  // `take` is set whenever the tab is shown; checked here too so the render below can use it.
  const showTab = isTabShown(snapshot) && !!tab && !!take;
  const playback = usePlayback({
    takeId,
    take: missing ? null : take,
    notes: notes ?? null,
    ...(readAudio ? { readAudio } : {}),
  });
  const { controller } = playback;

  // The Space and P shortcuts reach this screen's playback while its group is shown.
  useEffect(() => {
    if (!showTab) return;
    setActivePlayback(controller);
    return () => {
      if (activePlayback() === controller) setActivePlayback(null);
    };
  }, [showTab, controller]);

  // The shortcut registry reaches this session while the screen is mounted.
  useEffect(() => {
    setActiveTakeSession(session);
    return () => {
      if (activeTakeSession() === session) setActiveTakeSession(null);
    };
  }, [session]);

  // A state change can remove the focused control (Cancel, Analyse, Retry, or with the take
  // deleted, anything on the tab). Focus then moves to
  // the new state's primary button (Analyse after a cancel) or to the h1, never to <body>.
  // `focusInside` stays true when focus leaves to nothing, as when the focused control unmounts.
  const sectionRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const analyseButton = useRef<HTMLButtonElement>(null);
  const focusInside = useRef(false);
  const cancelled = analysis.kind === 'cancelled';
  // `missing` and whether the tab is shown count too: a take deleted elsewhere removes the
  // focused note, pencil or status-line button without changing the analysis state.
  const stateKey = `${analysis.kind}:${analysis.kind === 'running' && !!analysis.saving}:${
    analysis.kind === 'failed' ? analysis.code : ''
  }:${!!missing}:${showTab}`;
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
            labels={labels}
            countInBpm={barLines ? take.countInBpm : undefined}
            selectedNoteId={selectedNoteId}
            onSelect={(id) => session.select(id)}
            lastFocusedNoteId={snapshot.lastFocusedNoteId}
            onFocusNote={(id) => session.focusNote(id)}
            playingNoteId={playback.playingNoteId}
            playing={playback.playing}
            onNoteClick={(id) => {
              if (playback.playing) playback.seekToNote(id, false);
            }}
          />
        </div>
      </>
    );
  }
  const showToolbar = !missing && analysis.kind === 'idle' && !!tab && !!take;
  const showBarLines = showTab && take?.countInBpm !== undefined;

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
      {!missing && take && (
        <TakeWarnings
          take={take}
          notes={showToolbar && tab ? tab.notes : null}
          dismissed={dismissed}
          onDismiss={(kind) =>
            setDismissedFor({ warnings: take.warnings, kinds: new Set(dismissed).add(kind) })
          }
          focusAfterDismiss={() => titleRef.current?.focus()}
        />
      )}
      <TakeHeader
        fallbackTitle={strings['tab.title']}
        take={missing ? null : take}
        onRename={(t) => void session.rename(t)}
        titleRef={titleRef}
      />
      {showToolbar && (
        <div className={tabStyles.toolbar} role="toolbar" aria-label={strings['tab.toolbar']}>
          {showBarLines && (
            <button
              type="button"
              className={`${buttons.secondary} ${buttons.toggle} ${tabStyles.toolButton}`}
              aria-pressed={barLines}
              onClick={() => settings.setBarLines(!barLines)}
            >
              <BarLinesIcon className={tabStyles.toolIcon} />
              {strings['tab.barLines']}
            </button>
          )}
        </div>
      )}
      {showTab && tab && (
        <TabStatusLine
          notes={tab.notes}
          lastLineRef={lastStatusLine}
          onNextToCheck={() => {
            session.selectNextFlagged();
            focusSelectedNote(session.getSnapshot().selectedNoteId);
          }}
        />
      )}
      {showTab && <PlaybackControls playback={playback} />}
      {body}
    </section>
  );
}
