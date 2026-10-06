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
//
// Story "Change a fret and undo it": the session's edit outcomes are announced (an edit
// politely, "Fret 5 on the G string"; undo and redo with the step's label; a failed edit
// assertively), and an edit that could not be saved for lack of space shows the storage-full
// banner (testId `tab-edit-storage-full`) whose Retry saves the kept Tab. The edit keys
// themselves live in the shortcut registry.
//
// Story "String moves, delete, insert and confirm": the toolbar's Insert and Delete buttons
// (disabled while the tab is not shown; Delete also with nothing selected), the edit popover
// (components/EditPopover) a double-click on a note opens, and the announcements of a string
// move, a delete, an insert and a confirm.
//
// Story "Re-fit feedback": the notes an edit's re-fit re-fingered are outlined (DESIGN.md
// tab-note-refit) for REFIT_HOLD_MS, then fade out over REFIT_FADE_MS (with reduced motion they
// disappear at once), and "<n> nearby notes re-fingered" is announced after the edit's own
// announcement. A new edit's re-fit replaces the set (an edit that changed nothing leaves it);
// undo, redo, a failed edit, the tab going away (the take missing, an analysis) and leaving the
// screen clear it.
//
// Story "Undo and redo controls": Undo and Redo lead the toolbar. Their tooltips (a `title` and
// an accessible description, as the disabled Play's) name the step ("Undo move to string 3") or
// say "Nothing to undo"; Insert and Delete say why they are disabled ("No notes yet", "Select a
// note to delete"). A click undoes or redoes one step as the shortcuts do; a clicked button left
// disabled hands focus to the other.
//
// Story "Analysis settings and re-analysis" (US-4.6): the toolbar's Analysis settings toggle
// (after Bar lines; `aria-expanded`) opens an inline panel below the toolbar (not a dialog; Esc
// inside it closes it): the shared settings fields (components/AnalysisSettingsFields), each
// change saved to the take at once, and Re-analyse, the screen's only primary button (disabled
// with "No audio to analyse" when the take has no audio). With an edited (locked) note,
// Re-analyse asks first in the Confirm dialog (components/ConfirmDialog). While it runs the tab
// stays shown and the panel shows "Analysing…", the bar and Cancel; edits, undo and redo are
// disabled. The outcome (done, cancelled, failed) is announced. In No notes found the tip's
// "Analysis settings" is a link-styled button that opens the panel and focuses Sensitivity.
//
// Story "Copy and Download on the Tab screen" (CAP-18): the toolbar's Copy and Download (after
// Delete) export `toText` over the shown notes (ui/tab-export.ts), with bar lines only while the
// Bar lines toggle is on. Disabled in No notes found ("No notes to copy" / "No notes to
// download"); a re-analysis leaves them enabled (the shown tab is unchanged until it commits).
//
// Story "Trim": the toolbar's Trim toggle (before Bar lines; `aria-expanded`) opens the Trim
// strip (components/TrimStrip) below the toolbar. Trim is disabled with "Audio deleted" when the
// take has no audio, and while a re-analysis or trim runs; it stays enabled in No notes found.
// The strip and the Analysis settings panel are never open together: opening one closes the
// other. Save trims and re-analyses (`session.trim`), Reset trim re-analyses the full take; the
// run's progress and Cancel show in the strip. Notes outside the trim are hidden: the tab area,
// note labels, status line, warnings, playback and the popover see only the visible notes
// (`session/take-session.ts` `shownNotes`).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { CommandLabel } from '../../model/edit-history';
import type { AppErrorCode } from '../../model/errors';
import { visibleNotes } from '../../model/notes';
import type { Note, Take } from '../../model/types';
import { activePlayback, setActivePlayback } from '../../session/playback';
import { settingsSession, type SettingsSession } from '../../session/settings-session';
import {
  setActiveTakeSession,
  activeTakeSession,
  hasAudio,
  isTabShown,
  type EditEvent,
  type TakeAnalysisState,
  type TakeSession,
  type TakeSnapshot,
} from '../../session/take-session';
import { announce } from '../a11y/announcer';
import { NOTE_BUTTON } from '../a11y/selectors';
import { focusSelectedNote } from '../a11y/shortcuts';
import hidden from '../a11y/visually-hidden.module.css';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { AnalysisSettingsFields } from '../components/AnalysisSettingsFields';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TrimStrip, type TrimStripProps } from '../components/TrimStrip';
import { EditPopover } from '../components/EditPopover';
import {
  BarLinesIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  ErrorIcon,
  InsertIcon,
  RedoIcon,
  SettingsIcon,
  TrimIcon,
  UndoIcon,
} from '../components/icons';
import { StorageFullBannerView } from '../components/StorageFullBannerView';
import { PlaybackControls } from '../components/PlaybackControls';
import { noteLabels, reducedMotion, TabArea } from '../components/TabArea';
import { TabStatusLine } from '../components/TabStatusLine';
import { TakeHeader } from '../components/TakeHeader';
import { TakeWarnings, type DismissibleWarning } from '../components/TakeWarnings';
import { reloadOrExplain } from '../reload-or-explain';
import { strings } from '../strings';
import { copyTab, downloadTab, tabExportText } from '../tab-export';
import { showToast } from '../toast';
import { usePlayback } from '../use-playback';
import { useTakeSession } from '../use-take-session';
import styles from './Screen.module.css';
import tabStyles from './Tab.module.css';

/** The tab area's element id: the skip link's target. */
const TAB_AREA_ID = 'tab-area';
/** The Analysis settings panel's element id (the toggle's `aria-controls`). */
const PANEL_ID = 'analysis-settings';
/** The Trim strip's element id (the Trim toggle's `aria-controls`). */
const TRIM_ID = 'trim-strip';
/** The panel's Sensitivity slider's element id (the No notes found link focuses it). */
const SENSITIVITY_ID = 'analysis-sensitivity';

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

/** An edit command's name, as undo and redo announce it ("Set fret 5"). */
export function commandLabelText(label: CommandLabel): string {
  switch (label.kind) {
    case 'setFret':
      return strings['tab.commandSetFret'](label.fret);
    case 'moveString':
      return strings['tab.commandMoveString'](label.string);
    case 'delete':
      return strings['tab.commandDelete'];
    case 'insert':
      return strings['tab.commandInsert'];
    case 'confirm':
      return strings['tab.commandConfirm'];
    case 'reanalyse':
      return strings['tab.commandReanalyse'];
    case 'trim':
      return strings['tab.commandTrim'];
    case 'resetTrim':
      return strings['tab.commandResetTrim'];
  }
}

/**
 * A toolbar button with an icon, a text label and an optional tooltip: the tooltip goes on a
 * wrapper (a disabled button gets no pointer events) and is the button's accessible description,
 * as for the disabled Play button.
 */
function ToolButton({
  icon,
  label,
  tooltip,
  disabled,
  onClick,
  buttonRef,
  onFocus,
  onBlur,
  expanded,
  controls,
}: {
  icon: ReactNode;
  label: string;
  tooltip: string | null;
  disabled: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  onFocus?: () => void;
  onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
  /** A disclosure toggle (the Trim toggle): its `aria-expanded`, shown pressed while true. */
  expanded?: boolean;
  /** The element a disclosure toggle opens. */
  controls?: string | undefined;
}) {
  const tooltipId = useId();
  return (
    <span className={tabStyles.toolWrap} title={tooltip ?? undefined}>
      <button
        ref={buttonRef}
        type="button"
        className={`${buttons.secondary} ${expanded !== undefined ? buttons.toggle : ''} ${tabStyles.toolButton}`}
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls={controls}
        aria-describedby={tooltip !== null ? tooltipId : undefined}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {icon}
        {label}
      </button>
      {tooltip !== null && (
        <span id={tooltipId} className={hidden.visuallyHidden}>
          {tooltip}
        </span>
      )}
    </span>
  );
}

/** What an edit announces, by its command ("Moved to G string, fret 7"). */
function editText(event: Extract<EditEvent, { kind: 'edit' }>): string {
  switch (event.label.kind) {
    case 'setFret':
      return strings['tab.editFret'](event.fret, event.string);
    case 'moveString':
      return strings['tab.editMoved'](event.string, event.fret);
    case 'delete':
      return strings['tab.editDeleted'];
    case 'insert':
      return strings['tab.editInserted'](event.string, event.fret);
    case 'confirm':
      return strings['tab.editConfirmed'];
  }
}

/** What a failed re-analysis (`trim`: a trim or trim reset) announces, by its code. */
function reanalyseFailedText(code: AppErrorCode, trim: boolean): string {
  if (code === 'audio-missing') return strings['tab.noAudioToAnalyse'];
  if (code === 'engine-unavailable') return strings['global.engineFailed'];
  if (code === 'storage-full') return strings['tab.storageFull'];
  return trim ? strings['tab.trimFailed'] : strings['tab.reanalyseFailed'];
}

/** What an edit outcome announces, and how. */
export function editAnnouncement(event: EditEvent): [string, 'polite' | 'assertive'] {
  switch (event.kind) {
    case 'edit':
      return [editText(event), 'polite'];
    case 'undo':
      return [strings['tab.undone'](commandLabelText(event.label)), 'polite'];
    case 'redo':
      return [strings['tab.redone'](commandLabelText(event.label)), 'polite'];
    case 'failed':
      return [strings['tab.editFailed'], 'assertive'];
    case 'reanalysed':
      return [strings['tab.reanalysed'](event.notes), 'polite'];
    case 'trimmed':
      return [
        event.reset
          ? strings['tab.trimResetDone'](event.notes)
          : strings['tab.trimmed'](event.notes),
        'polite',
      ];
    case 'reanalyseCancelled':
      return [
        event.trim ? strings['tab.trimCancelled'] : strings['tab.reanalyseCancelled'],
        'polite',
      ];
    case 'reanalyseFailed':
      return [reanalyseFailedText(event.code, event.trim === true), 'assertive'];
  }
}

/**
 * The Analysis settings panel (DESIGN.md, mockup tab.html (c)): an inline section, not a
 * dialog. Its fields save to the take on each committed change; Re-analyse runs at once, or
 * after the Confirm dialog when a note is locked. While a re-analysis runs: the fields and
 * Re-analyse are disabled, and "Analysing…", the bar and Cancel show.
 */
function AnalysisSettingsPanel({
  take,
  notes,
  reanalysis,
  audio,
  session,
  onEscape,
}: {
  take: Take;
  /** The shown (visible) notes: a locked one asks first. Hidden locked notes stay untouched. */
  notes: readonly Note[];
  reanalysis: TakeSnapshot['reanalysis'];
  /** Whether the take has audio to re-analyse. */
  audio: boolean;
  session: TakeSession;
  onEscape(): void;
}) {
  const headingId = useId();
  const reasonId = useId();
  const [confirming, setConfirming] = useState(false);
  const reanalyseButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const running = reanalysis !== null;
  const reason = audio ? null : strings['tab.noAudioToAnalyse'];

  // Focus follows the run: from Re-analyse (disabled) to Cancel when it starts, and back to
  // Re-analyse when it ends with focus lost (Cancel gone).
  const wasRunning = useRef(running);
  useLayoutEffect(() => {
    const before = wasRunning.current;
    wasRunning.current = running;
    if (before === running) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (running && (lost || active === reanalyseButton.current)) cancelButton.current?.focus();
    if (!running && lost) reanalyseButton.current?.focus();
  }, [running]);

  // Failures are announced through the session's edit events.
  const start = () => void session.reanalyse().catch(() => {});
  const percent = strings['tab.analysingPercent'](percentOf(reanalysis?.progress ?? 0));

  return (
    <section
      id={PANEL_ID}
      className={tabStyles.panel}
      aria-labelledby={headingId}
      data-testid="analysis-settings"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); // the Tab screen's Esc (clear the selection) does not run too
        onEscape();
      }}
    >
      <h2 id={headingId} className={tabStyles.panelTitle}>
        {strings['tab.analysisSettings']}
      </h2>
      <AnalysisSettingsFields
        settings={take.settings}
        onChange={(patch) => void session.setSettings(patch)}
        disabled={running}
        sensitivityId={SENSITIVITY_ID}
      >
        <span className={tabStyles.toolWrap} title={reason ?? undefined}>
          <button
            ref={reanalyseButton}
            type="button"
            className={buttons.primary}
            disabled={!audio || running}
            aria-describedby={reason !== null ? reasonId : undefined}
            onClick={() => {
              if (notes.some((n) => n.locked)) setConfirming(true);
              else start();
            }}
          >
            {strings['tab.reanalyse']}
          </button>
          {reason !== null && (
            <span id={reasonId} className={hidden.visuallyHidden}>
              {reason}
            </span>
          )}
        </span>
      </AnalysisSettingsFields>
      {running && (
        <div className={tabStyles.panelProgress} data-testid="reanalysis-progress">
          <label className={tabStyles.label} htmlFor="tab-reanalysis-progress">
            {strings['tab.analysing']}
          </label>
          <div className={tabStyles.progressRow}>
            <progress
              id="tab-reanalysis-progress"
              className={tabStyles.progress}
              max={1}
              value={reanalysis.progress}
              aria-valuetext={percent}
            />
            <span className={tabStyles.percent}>{percent}</span>
            <button
              ref={cancelButton}
              type="button"
              className={buttons.secondary}
              onClick={() => session.cancelReanalysis()}
            >
              {strings['tab.cancel']}
            </button>
          </div>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={strings['tab.reanalyseConfirmTitle'](take.title)}
          body={strings['tab.reanalyseConfirmBody']}
          confirmLabel={strings['tab.reanalyse']}
          opener={() => reanalyseButton.current}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            start();
          }}
        />
      )}
    </section>
  );
}

/**
 * The storage-full banner for an edit that could not be saved (EXPERIENCE.md Storage full): the
 * Tab is kept, and Retry saves it again. Announced assertively once per showing.
 */
function EditSaveBanner({ session }: { session: TakeSession }) {
  const text = strings['tab.storageFull'];
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    announce(text, 'assertive');
  }, [text]);
  return (
    <StorageFullBannerView
      text={text}
      className={tabStyles.banner}
      testId="tab-edit-storage-full"
      retry={{ label: strings['tab.retry'], onClick: () => session.retrySave() }}
    />
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
  /** The Trim strip's waveform peaks; tests pass their own. */
  loadPeaks?: TrimStripProps['loadPeaks'];
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

/** How long the re-fit outline is held before it fades (EXPERIENCE.md Note (in tab)). */
export const REFIT_HOLD_MS = 1500;
/** How long the re-fit outline takes to fade (matches the CSS transition). */
export const REFIT_FADE_MS = 300;

/** The re-fit outline: the notes it is on, and whether it is fading out. */
interface RefitOutline {
  ids: ReadonlySet<string>;
  fading: boolean;
}

const NO_REFIT: RefitOutline = { ids: new Set(), fading: false };

/**
 * The re-fit outline's state and timer (story "Re-fit feedback"): `show` replaces the outlined
 * set and restarts the timer, `clear` drops it at once. Cleared on unmount.
 */
function useRefitOutline() {
  const [refit, setRefit] = useState<RefitOutline>(NO_REFIT);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [controls] = useState(() => {
    const stop = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    return {
      stop,
      show(ids: readonly string[]) {
        stop();
        if (ids.length === 0) {
          setRefit(NO_REFIT);
          return;
        }
        setRefit({ ids: new Set(ids), fading: false });
        timer.current = setTimeout(() => {
          if (reducedMotion()) {
            timer.current = null;
            setRefit(NO_REFIT);
            return;
          }
          setRefit((r) => ({ ...r, fading: true }));
          timer.current = setTimeout(() => {
            timer.current = null;
            setRefit(NO_REFIT);
          }, REFIT_FADE_MS);
        }, REFIT_HOLD_MS);
      },
      clear() {
        stop();
        setRefit(NO_REFIT);
      },
    };
  });
  useEffect(() => controls.stop, [controls]);
  return { refit, show: controls.show, clear: controls.clear };
}

/** No warning dismissed. */
const NONE_DISMISSED: ReadonlySet<DismissibleWarning> = new Set();

export function Tab({
  takeId,
  createSession,
  settings = settingsSession,
  readAudio,
  loadPeaks,
}: TabProps) {
  const { snapshot, session } = useTakeSession(takeId, createSession);
  const { take, tab, analysis, missing, selectedNoteId, reanalysis } = snapshot;
  // A re-analysis's progress is announced as a first analysis's is.
  useProgressAnnouncements(
    reanalysis ? { kind: 'running', progress: reanalysis.progress } : analysis,
  );
  useMaxLengthToast(missing ? null : take);
  const { barLines } = useSyncExternalStore(settings.subscribePrefs, settings.getSnapshot).prefs;
  const [noteList, setNoteList] = useState(false);
  /**
   * The open panel below the toolbar: the Analysis settings panel or the Trim strip, never both
   * (opening one closes the other).
   */
  const [openPanel, setOpenPanel] = useState<'settings' | 'trim' | null>(null);
  /** Set by the No notes found link: Sensitivity takes focus once the panel shows. */
  const focusSensitivity = useRef(false);
  const panelToggle = useRef<HTMLButtonElement>(null);
  const trimToggle = useRef<HTMLButtonElement>(null);
  /** The note the edit popover is open on, and the button it opened from. */
  const [popover, setPopover] = useState<{ noteId: string; anchor: HTMLElement } | null>(null);
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
  // The notes the trim leaves visible (story "Trim"): all the screen renders, counts and plays.
  const allNotes = tab?.notes;
  const trimStartMs = take?.trimStartMs ?? 0;
  const trimEndMs = take?.trimEndMs ?? null;
  const notes = useMemo(
    () => (allNotes ? visibleNotes(allNotes, { trimStartMs, trimEndMs }) : undefined),
    [allNotes, trimStartMs, trimEndMs],
  );
  const labels = useMemo(() => (notes ? noteLabels(notes) : []), [notes]);
  // `take` is set whenever the tab is shown; checked here too so the render below can use it.
  const showTab = isTabShown(snapshot) && !!tab && !!take;
  const playback = usePlayback({
    takeId,
    take: missing ? null : take,
    // The cursor follows the visible notes only.
    notes: notes ?? null,
    ...(readAudio ? { readAudio } : {}),
  });
  const { controller } = playback;
  const refitOutline = useRefitOutline();
  const { show: showRefit, clear: clearRefit } = refitOutline;
  // The outline goes with the tab: the take missing, an analysis.
  const refit = showTab ? refitOutline.refit : NO_REFIT;
  useEffect(() => {
    if (!showTab) clearRefit();
  }, [showTab, clearRefit]);

  // The Space and P shortcuts reach this screen's playback while its group is shown.
  useEffect(() => {
    if (!showTab) return;
    setActivePlayback(controller);
    return () => {
      if (activePlayback() === controller) setActivePlayback(null);
    };
  }, [showTab, controller]);

  // The session's edit outcomes are announced through the shared live region (spine AD-18).
  useEffect(
    () =>
      session.onEditEvent((event) => {
        const [message, politeness] = editAnnouncement(event);
        announce(message, politeness);
        // A failed edit takes the outline away; an edit that changed nothing leaves it.
        if (event.kind === 'failed' || event.kind === 'reanalysed' || event.kind === 'trimmed') {
          clearRefit();
        }
        if (event.kind === 'edit' && event.refingered) {
          // A new re-fit replaces the outline (none: it goes); its news follows the edit's.
          showRefit(event.refingered);
          const n = event.refingered.length;
          if (n > 0) announce(strings['tab.refingered'](n));
        }
        // Undo and redo select the step's note; focus on a note follows it there.
        if (event.kind === 'undo' || event.kind === 'redo') {
          clearRefit();
          if (document.activeElement?.closest(NOTE_BUTTON)) {
            focusSelectedNote(session.getSnapshot().selectedNoteId);
          }
        }
      }),
    [session, showRefit, clearRefit],
  );

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

  // A clicked Undo or Redo that its own step disabled hands focus to the other button, so focus
  // is never lost to <body>. `travelFocus` is the one of them holding focus.
  const undoButton = useRef<HTMLButtonElement>(null);
  const redoButton = useRef<HTMLButtonElement>(null);
  const travelFocus = useRef<'undo' | 'redo' | null>(null);
  const canUndo = snapshot.undoLabel !== null;
  const canRedo = snapshot.redoLabel !== null;
  const showToolbar = !missing && analysis.kind === 'idle' && !!tab && !!take;
  /** Whether edits apply: the tab is shown and no re-analysis runs. */
  const editable = showTab && reanalysis === null;
  const trimRun = reanalysis !== null && reanalysis.trim === true;
  // The panel stays open while a re-analysis runs: its progress and Cancel are there; the strip
  // likewise while a trim runs.
  const showPanel = showToolbar && !trimRun && (openPanel === 'settings' || reanalysis !== null);
  const showTrim = showToolbar && (trimRun || (openPanel === 'trim' && reanalysis === null));
  const audio = hasAudio(snapshot);
  useLayoutEffect(() => {
    if (!focusSensitivity.current || !showPanel) return;
    focusSensitivity.current = false;
    document.getElementById(SENSITIVITY_ID)?.focus();
  }, [showPanel]);
  useLayoutEffect(() => {
    // A hidden toolbar takes its buttons (and their focus) with it, with no blur to release it.
    if (!showToolbar) {
      travelFocus.current = null;
      return;
    }
    const held = travelFocus.current;
    if (held === null) return;
    const [from, to] =
      held === 'undo'
        ? [undoButton.current, redoButton.current]
        : [redoButton.current, undoButton.current];
    if (!from?.disabled) return;
    // Handled once: a disabled button holds no focus to hand over later.
    travelFocus.current = null;
    if (!to || to.disabled) return;
    const active = document.activeElement;
    if (active !== from && active !== null && active !== document.body) return;
    to.focus();
  }, [canUndo, canRedo, showToolbar]);
  const onTravelBlur = (event: FocusEvent<HTMLButtonElement>) => {
    // Focus leaving for another element releases it; a blur to nothing (the button disabled)
    // keeps it, for the effect above.
    if (event.relatedTarget !== null || !event.currentTarget.disabled) travelFocus.current = null;
  };

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
  } else if (analysis.kind === 'idle' && tab && take && notes?.length === 0) {
    body = (
      <div className={tabStyles.noNotes} data-testid="tab-no-notes">
        <h2 className={tabStyles.noNotesTitle}>{strings['tab.noNotes']}</h2>
        <ul className={tabStyles.tips}>
          <li>{strings['tab.noNotesTipLevel']}</li>
          <li>{strings['tab.noNotesTipSingle']}</li>
          <li>
            {strings['tab.noNotesTipSensitivityLead']}
            <button
              type="button"
              className={tabStyles.linkButton}
              onClick={() => {
                if (showPanel) {
                  document.getElementById(SENSITIVITY_ID)?.focus();
                  return;
                }
                focusSensitivity.current = true;
                setOpenPanel('settings');
              }}
            >
              {strings['tab.analysisSettings']}
            </button>
          </li>
        </ul>
      </div>
    );
  } else if (analysis.kind === 'idle' && tab && take && notes && notes.length > 0) {
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
            notes={notes}
            labels={labels}
            countInBpm={barLines ? take.countInBpm : undefined}
            selectedNoteId={selectedNoteId}
            onSelect={(id) => session.select(id)}
            lastFocusedNoteId={snapshot.lastFocusedNoteId}
            onFocusNote={(id) => session.focusNote(id)}
            playingNoteId={playback.playingNoteId}
            refitIds={refit.ids}
            refitFading={refit.fading}
            playing={playback.playing}
            onNoteClick={(id) => {
              if (playback.playing) playback.seekToNote(id, false);
            }}
            onNoteDoubleClick={(id, anchor) => setPopover({ noteId: id, anchor })}
          />
        </div>
      </>
    );
  }
  const popoverNote =
    showTab && popover ? (notes?.find((n) => n.id === popover.noteId) ?? null) : null;
  // A popover whose note went away (an undo, a re-analysis) stays closed if the note comes back;
  // a re-analysis starting closes it too (its edits would do nothing).
  if (popover !== null && (popoverNote === null || reanalysis !== null)) setPopover(null);
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
      {!missing && snapshot.saveFailed === 'storage-full' && <EditSaveBanner session={session} />}
      {!missing && take && (
        <TakeWarnings
          take={take}
          notes={showToolbar && notes ? notes : null}
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
          <ToolButton
            buttonRef={undoButton}
            icon={<UndoIcon className={tabStyles.toolIcon} />}
            label={strings['tab.undo']}
            tooltip={
              snapshot.undoLabel
                ? strings['tab.undoAction'](snapshot.undoLabel)
                : strings['tab.nothingToUndo']
            }
            disabled={!canUndo}
            onClick={() => void session.undo()}
            onFocus={() => {
              travelFocus.current = 'undo';
            }}
            onBlur={onTravelBlur}
          />
          <ToolButton
            buttonRef={redoButton}
            icon={<RedoIcon className={tabStyles.toolIcon} />}
            label={strings['tab.redo']}
            tooltip={
              snapshot.redoLabel
                ? strings['tab.redoAction'](snapshot.redoLabel)
                : strings['tab.nothingToRedo']
            }
            disabled={!canRedo}
            onClick={() => void session.redo()}
            onFocus={() => {
              travelFocus.current = 'redo';
            }}
            onBlur={onTravelBlur}
          />
          <ToolButton
            icon={<InsertIcon className={tabStyles.toolIcon} />}
            label={strings['tab.insert']}
            tooltip={showTab ? null : strings['tab.noNotesYet']}
            disabled={!editable}
            onClick={() => void session.insert()}
          />
          <ToolButton
            icon={<DeleteIcon className={tabStyles.toolIcon} />}
            label={strings['tab.delete']}
            tooltip={
              !showTab
                ? strings['tab.noNotesYet']
                : selectedNoteId === null
                  ? strings['tab.selectToDelete']
                  : null
            }
            disabled={!editable || selectedNoteId === null}
            onClick={() => void session.deleteSelected()}
          />
          <ToolButton
            icon={<CopyIcon className={tabStyles.toolIcon} />}
            label={strings['tab.copy']}
            tooltip={showTab ? null : strings['tab.noNotesToCopy']}
            disabled={!showTab}
            onClick={() => {
              if (notes) void copyTab(tabExportText(take, notes, barLines));
            }}
          />
          <ToolButton
            icon={<DownloadIcon className={tabStyles.toolIcon} />}
            label={strings['tab.download']}
            tooltip={showTab ? null : strings['tab.noNotesToDownload']}
            disabled={!showTab}
            onClick={() => {
              if (notes) downloadTab(take.title, tabExportText(take, notes, barLines));
            }}
          />
          <ToolButton
            buttonRef={trimToggle}
            icon={<TrimIcon className={tabStyles.toolIcon} />}
            label={strings['tab.trim']}
            tooltip={
              !audio
                ? strings['tab.audioDeleted']
                : trimRun
                  ? strings['tab.busyTrimming']
                  : reanalysis !== null
                    ? strings['tab.busyReanalysing']
                    : null
            }
            disabled={!audio || reanalysis !== null}
            expanded={showTrim}
            controls={showTrim ? TRIM_ID : undefined}
            onClick={() => setOpenPanel(showTrim ? null : 'trim')}
          />
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
          <ToolButton
            buttonRef={panelToggle}
            icon={<SettingsIcon className={tabStyles.toolIcon} />}
            label={strings['tab.analysisSettings']}
            // While a trim runs its strip stays open, so the panel cannot open.
            tooltip={trimRun ? strings['tab.busyTrimming'] : null}
            disabled={trimRun}
            expanded={showPanel}
            controls={showPanel ? PANEL_ID : undefined}
            // While a re-analysis runs the panel stays open: its progress and Cancel are there.
            onClick={() => setOpenPanel(reanalysis !== null || !showPanel ? 'settings' : null)}
          />
        </div>
      )}
      {showPanel && notes && take && (
        <AnalysisSettingsPanel
          take={take}
          notes={notes}
          reanalysis={reanalysis}
          audio={audio}
          session={session}
          onEscape={() => {
            if (reanalysis !== null) return; // its progress and Cancel stay while it runs
            setOpenPanel(null);
            panelToggle.current?.focus();
          }}
        />
      )}
      {showTrim && notes && take && (
        <div id={TRIM_ID}>
          <TrimStrip
            take={take}
            lockedShown={notes.some((n) => n.locked)}
            running={trimRun ? reanalysis : null}
            onSave={(start, end) => void session.trim(start, end).catch(() => {})}
            onReset={() => void session.resetTrim().catch(() => {})}
            onCancel={() => session.cancelReanalysis()}
            onEscape={() => {
              setOpenPanel(null);
              trimToggle.current?.focus();
            }}
            {...(loadPeaks ? { loadPeaks } : {})}
          />
        </div>
      )}
      {showTab && notes && (
        <TabStatusLine
          notes={notes}
          lastLineRef={lastStatusLine}
          onNextToCheck={() => {
            session.selectNextFlagged();
            focusSelectedNote(session.getSnapshot().selectedNoteId);
          }}
        />
      )}
      {showTab && <PlaybackControls playback={playback} />}
      {body}
      {popover && popoverNote && take && (
        <EditPopover
          key={popover.noteId}
          note={popoverNote}
          maxFret={take.settings.maxFret}
          anchor={popover.anchor}
          onSetFret={(fret) => void session.setFret(popoverNote.id, fret)}
          onMove={(string) => void session.moveString(popoverNote.id, string)}
          onConfirm={() => void session.confirm(popoverNote.id)}
          onClose={() => setPopover(null)}
          returnFocusTo={() => session.getSnapshot().selectedNoteId ?? popoverNote.id}
        />
      )}
    </section>
  );
}
