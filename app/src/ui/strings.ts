import type { CommandLabel } from '../model/edit-history';
import type { StringNo } from '../model/types';
import { formatSigned } from './number-format';

/** The tuner's spoken string names, `StringNo` 1 = high e … 6 = low E. */
const STRING_NAMES: Readonly<Record<StringNo, string>> = {
  1: 'High E',
  2: 'B',
  3: 'G',
  4: 'D',
  5: 'A',
  6: 'Low E',
};

/** The note labels' string names (US-6.2), `StringNo` 1 = high E … 6 = low E. */
const TAB_STRING_NAMES: Readonly<Record<StringNo, string>> = {
  1: 'high E',
  2: 'B',
  3: 'G',
  4: 'D',
  5: 'A',
  6: 'low E',
};

/** Signed, rounded cents with U+2212 for minus: "+12", "−1", "0". */
function signedCents(cents: number): string {
  return formatSigned(Math.round(cents));
}

/**
 * Every user-visible string (spine AD-12). One flat object; keys are
 * `<screen|global>.<camelCase>`. Parameterised strings are typed functions.
 */
/** An edit command as Undo's and Redo's tooltips name it, mid-sentence: "move to string 3". */
function commandPhrase(label: CommandLabel): string {
  switch (label.kind) {
    case 'setFret':
      return `set fret ${label.fret}`;
    case 'moveString':
      return `move to string ${label.string}`;
    case 'delete':
      return 'delete note';
    case 'insert':
      return 'insert note';
    case 'confirm':
      return 'confirm note';
    case 'reanalyse':
      return 're-analyse';
    case 'trim':
      return 'trim';
    case 'resetTrim':
      return 'reset trim';
  }
}

export const strings = {
  'global.appName': 'TabCreator',
  'global.navLabel': 'Main',
  'global.navRecord': 'Record',
  'global.navLibrary': 'Library',
  'global.navTuner': 'Tuner',
  'global.navSettings': 'Settings',
  'global.engineFailed': 'The analysis engine failed to load',
  'global.reload': 'Reload',
  'global.cancel': 'Cancel',
  // The analysis settings (US-4.6; mockup tab.html (c), settings.html): the Tab screen's
  // Analysis settings panel and the Settings screen's "Defaults for new takes".
  'global.sensitivity': 'Sensitivity',
  'global.fewerNotes': 'Fewer notes',
  'global.moreNotes': 'More notes',
  /** The sensitivity's shown value, 2 decimals: "0.35". */
  'global.sensitivityValue': (value: number) => value.toFixed(2),
  /** The slider's `aria-valuetext`: "0.35, fewer notes at 0, more at 1". */
  'global.sensitivityValueText': (value: number) =>
    `${value.toFixed(2)}, fewer notes at 0, more at 1`,
  'global.minNoteLength': 'Minimum note length',
  'global.ms': 'ms',
  'global.highestFret': 'Highest fret',
  /**
   * The update prompt's toast, with the action `global.reload` (EXPERIENCE.md "Update available":
   * Toast "Update available — Reload"); never shown while the app is busy.
   */
  'global.updateAvailable': 'Update available',
  /**
   * The toast when a Reload (Settings', the Tab screen's engine banner or the update toast's) is
   * refused: a take is being recorded or saved, or a recovered take rebuilt (story 5.2), a take
   * analysed (story 5.6), a Tab edit could not be saved (or is held for Retry), or a library
   * backup or restore runs (story "Update available prompt"); new copy, not yet in EXPERIENCE.md.
   */
  'global.reloadBusy':
    "Can't reload while TabCreator is recording, analysing, saving or backing up",
  /** The persistent update toast's close button's accessible name. */
  'global.updateDismiss': 'Dismiss update notice',
  'global.microphone': 'Microphone',
  /** The option text for an input the browser gives no label. */
  'global.microphoneUnnamed': (n: number) => `Microphone ${n}`,
  /** The Microphone select's reason while a take runs (EXPERIENCE.md Microphone select). */
  'global.microphoneBusy': "Can't change the microphone while recording",
  /** Toast when the active input is unplugged and another one takes over (EXPERIENCE.md). */
  'global.micSwitched': (label: string) => `Microphone disconnected — switched to ${label}`,
  /** Toast when the input a take was recording is unplugged; the take is saved (EXPERIENCE.md). */
  'global.micStoppedSaved': 'Microphone disconnected — recording stopped and saved',
  'global.inputLevel': 'Input level',
  'global.levelUnit': 'dBFS',
  'global.levelTooLoud': 'Too loud — move back or lower the input',
  'global.levelTooQuiet': 'Too quiet — move closer to the guitar',
  /** The meter's `aria-valuetext`: "−20 dBFS", "−6 dBFS, too loud", "−50 dBFS, too quiet". */
  'global.levelValueText': (db: number, warning: 'loud' | 'quiet' | null) =>
    `${formatSigned(db)} dBFS${
      warning === 'loud' ? ', too loud' : warning === 'quiet' ? ', too quiet' : ''
    }`,
  /** The input quality warning banner (EXPERIENCE.md Bluetooth / low-rate input). */
  'global.inputQualityWarning':
    'This microphone may be a Bluetooth headset in call mode — accuracy will be poor. Use the built-in or a wired mic.',
  'global.dismiss': 'Dismiss',
  /**
   * A toast when a backup finishes after the player left the Library (story 7.17); the Library's
   * banner then offers it.
   */
  'global.backupReady': 'Backup ready — download it from the Library',
  /**
   * EXPERIENCE.md's Storage full copy, which never says "saved": Record's banner when nothing was
   * saved (or storage filled elsewhere), the Library's banner, and the Tab screen's storage-full
   * save failures.
   */
  'global.storageFull': 'Storage is full — delete takes or their audio, or back up and clear',
  'global.inputQualityDismissLabel': 'Dismiss Bluetooth warning for this session',
  /** The full-screen notice while another tab runs the app (EXPERIENCE.md Open in another tab). */
  'global.instanceOtherTab': 'TabCreator is open in another tab',
  /** Its button: moves the app to this tab. */
  'global.instanceUseHere': 'Use here',
  /** The notice's status line while Use here moves the app to this tab. */
  'global.instanceMovingHere': 'Moving TabCreator here…',
  /** The lost tab's line when its take was saved as the app moved away (story 5.3). */
  'global.instanceTakeSaved': "Your recording was saved — it's in the Library in the other tab",
  /** The lost tab's line when that save failed (story 5.3): the other tab offers recovery. */
  'global.instanceTakeNotSaved':
    "Your recording wasn't saved here — the other tab will offer to recover it",
  /** The full-screen notice while a database upgrade waits (EXPERIENCE.md Update blocked). */
  'global.instanceUpgradeBlocked': 'Close other TabCreator tabs to finish updating',
  /** The full-screen notice without the browser APIs the app needs (EXPERIENCE.md). */
  'global.unsupported': 'TabCreator needs a recent desktop Chrome',
  // The mic setup / error card (MicGate), shared by Record and Tuner.
  'global.micSetupTitle': 'TabCreator needs your microphone',
  'global.micSetupText': 'Audio is analysed on this computer and never uploaded.',
  'global.allowMic': 'Allow microphone',
  'global.tryAgain': 'Try again',
  /** The storage-full banner's link to the Library (Record and Tab). */
  'global.goToLibrary': 'Go to Library',
  'global.micErrorMicDeniedTitle': 'Microphone access is blocked',
  'global.micErrorMicDeniedBody': 'Chrome is blocking the microphone for this site. To allow it:',
  'global.micErrorMicDeniedStep1':
    'Click the site settings icon at the left end of the address bar.',
  'global.micErrorMicDeniedStep2': 'Turn on Microphone.',
  'global.micErrorMicDeniedStep3': 'Come back here and choose Try again.',
  'global.micErrorMicNoDeviceTitle': 'No microphone found',
  'global.micErrorMicNoDeviceBody': "Chrome can't find a microphone. To fix it:",
  'global.micErrorMicNoDeviceStep1':
    'Plug in a microphone or headset, or turn on your built-in mic.',
  'global.micErrorMicNoDeviceStep2': 'If your computer has a mic mute switch or key, turn it off.',
  'global.micErrorMicNoDeviceStep3': 'Come back here and choose Try again.',
  'global.micErrorMicInUseTitle': 'Your microphone is busy',
  'global.micErrorMicInUseBody': 'Another app or tab is using the microphone. To free it:',
  'global.micErrorMicInUseStep1': 'Close apps that use the mic, such as video calls.',
  'global.micErrorMicInUseStep2': 'Close other browser tabs that are using the microphone.',
  'global.micErrorMicInUseStep3': 'Come back here and choose Try again.',
  'global.micErrorMicFailedTitle': "The microphone didn't start",
  'global.micErrorMicFailedBody': 'Something went wrong opening the microphone. To fix it:',
  'global.micErrorMicFailedStep1': 'Unplug the microphone and plug it back in.',
  'global.micErrorMicFailedStep2': "Check it works in your computer's sound settings.",
  'global.micErrorMicFailedStep3': 'Come back here and choose Try again.',
  'global.micErrorMicLostTitle': 'Microphone access was lost',
  'global.micErrorMicLostBody': 'The microphone stopped or access was turned off. To get it back:',
  'global.micErrorMicLostStep1': 'Check the microphone is still plugged in.',
  'global.micErrorMicLostStep2':
    'Check Microphone is still allowed in the site settings icon at the left end of the address bar.',
  'global.micErrorMicLostStep3': 'Choose Try again.',
  'record.title': 'Record',
  'record.tuneFirst': 'Tune first',
  'record.record': 'Record',
  'record.stop': 'Stop',
  /** The indicator above the timer while a take records. */
  'record.recording': 'Recording',
  /** Under the timer from 4:30, and announced once (EXPERIENCE.md Recording near limit). */
  'record.nearLimit': '30 seconds left',
  /** The toast after a take under 0.5 s is discarded (EXPERIENCE.md Take too short). */
  'record.tooShort': 'Too short — nothing recorded',
  /** Announced when a take starts capturing. */
  'record.started': 'Recording started',
  /** Announced when a take is saved. */
  'record.stopped': 'Recording stopped',
  /** The error banner after a take is stopped because storage is full (story 3.9). */
  'record.storageFull': 'Storage is full — recording stopped and saved',
  /**
   * The toast when a stopped take could not be saved (story 5.2; new copy, not yet in
   * EXPERIENCE.md): the take is offered for recovery by the recovered-take banner.
   */
  'record.saveFailed': "Recording stopped but couldn't be saved — you'll be offered it to recover",
  /** The recovered-take banner (EXPERIENCE.md Recovered take): the take's start time and length. */
  'record.recovered': (time: string, length: string) =>
    `An unfinished take from ${time} was recovered (${length})`,
  /** The banner's text while Open rebuilds the take. */
  'record.recovering': 'Recovering…',
  'record.recoveredOpen': 'Open',
  'record.recoveredDiscard': 'Discard',
  /** The recording timer's accessible name: "Elapsed time 0:42". */
  'record.elapsed': (time: string) => `Elapsed time ${time}`,
  /** The Space shortcut's description in the keyboard shortcuts dialog (EXPERIENCE.md). */
  'record.shortcutRecordStop': 'Record / stop',
  /** The count-in toggle (EXPERIENCE.md Count-in controls). */
  'record.countIn': 'Count-in',
  /** The count-in tempo field's label and unit. */
  'record.tempo': 'Tempo',
  'record.bpm': 'BPM',
  /** The Record button's label during a count-in. */
  'record.cancel': 'Cancel',
  /** The Record button's accessible name during a count-in. */
  'record.cancelCountIn': 'Cancel count-in',
  /** The indicator above the beat number during a count-in: "Count-in · 90 BPM". */
  'record.countInState': (bpm: number) => `Count-in · ${bpm} BPM`,
  /** A count-in beat, as shown and announced (4, 3, 2, 1). */
  'record.countInBeat': (beat: number) => `${beat}`,
  /** The Esc shortcut's description in the keyboard shortcuts dialog (EXPERIENCE.md). */
  'global.shortcutCancelCountIn': 'Cancel count-in',
  'tab.title': 'Tab',
  /** The progress bar's label while a take is analysed. */
  'tab.analysing': 'Analysing…',
  /**
   * The percentage beside the progress bar: `Math.floor(progress · 100)`, with a 1e-9 epsilon so
   * float error (0.29 · 100 = 28.999…) does not show one percent low.
   */
  'tab.analysingPercent': (percent: number) => `${percent}%`,
  /** Announced politely as the analysis crosses 25, 50, 75 and 100% (EXPERIENCE.md). */
  'tab.analysingAnnounce': (percent: number) => `Analysing, ${percent}%`,
  /** Beside the progress bar: stops the analysis (US-4.5). */
  'tab.cancel': 'Cancel',
  /** After a cancel: analyses the take again (US-4.5). */
  'tab.analyse': 'Analyse',
  /** The error banner when the analysis failed (EXPERIENCE.md Analysis failed, spine AD-10). */
  'tab.analysisFailed': 'Analysis failed — try again',
  /** The Analysis failed and Storage full banners' button. */
  'tab.retry': 'Retry',
  /** An analysed take with no notes (EXPERIENCE.md No notes found), then its three tips. */
  'tab.noNotes': 'No notes found',
  /** No notes found, tip 1: the input may have been too quiet. */
  'tab.noNotesTipLevel': 'Check the input level',
  /** No notes found, tip 2: chords and ringing strings detect poorly. */
  'tab.noNotesTipSingle': 'Play single notes',
  /** No notes found, tip 3: plain text until story 8.6 links it to the Analysis settings panel. */
  /** The tip's text before its "Analysis settings" link (`tab.analysisSettings`). */
  'tab.noNotesTipSensitivityLead': 'Raise sensitivity in ',
  /** The toolbar toggle, the panel's heading and the No notes found tip's link. */
  'tab.analysisSettings': 'Analysis settings',
  'tab.reanalyse': 'Re-analyse',
  /** Re-analyse's reason while the take has neither compressed audio nor a raw file. */
  'tab.noAudioToAnalyse': 'No audio to analyse',
  /** The Confirm dialog before re-analysing a take with edited (locked) notes (US-4.6). */
  'tab.reanalyseConfirmTitle': (title: string) => `Re-analyse ${title}?`,
  'tab.reanalyseConfirmBody':
    "Re-analysing replaces notes you haven't edited. Your edited notes are kept.",
  'tab.reanalyseCancelled': 'Re-analysis cancelled',
  'tab.reanalyseFailed': 'Re-analysis failed — try again',
  'tab.reanalysed': (n: number) => `Re-analysed: ${n} ${n === 1 ? 'note' : 'notes'}`,
  /** Shown in place of the progress bar while the result is being saved (no Cancel). */
  'tab.saving': 'Saving…',
  /** Shown when the take does not exist. */
  'tab.notFound': 'Take not found',
  /** The pencil button beside the title: switches it to a text field (DESIGN.md Inline-editable title). */
  'tab.rename': 'Rename take',
  /** The title field's accessible name while renaming. */
  'tab.titleField': 'Take title',
  /** The line under the title: recording date and time, then the duration. */
  'tab.meta': (date: string, duration: string) => `${date} · ${duration}`,
  /** The skip link, the screen's first focusable element (EXPERIENCE.md Accessibility floor). */
  'tab.skipToTab': 'Skip to tab',
  /** The toolbar's accessible name (its buttons come with later stories). */
  'tab.toolbar': 'Tab tools',
  /** The tab area's accessible name (`role="application"`). */
  'tab.area': 'Tab',
  /** The tab area's instructions, read through aria-describedby. */
  'tab.areaInstructions':
    'Use Tab to reach the notes, Left and Right arrows to move between notes, Escape to clear the selection, Space to play or pause, N to go to the next note to check, and P to play from the selected note.',
  /** One system's accessible name: "Tab system 1 of 3". */
  'tab.system': (i: number, n: number) => `Tab system ${i} of ${n}`,
  /**
   * A note's accessible name (US-6.2): "Note 12: B string, fret 3, D4, at 4.25 seconds". `n` is
   * its 1-based place in played order, `seconds` its start with two decimals.
   */
  'tab.noteLabel': (n: number, string: StringNo, fret: number, pitch: string, seconds: string) =>
    `Note ${n}: ${TAB_STRING_NAMES[string]} string, fret ${fret}, ${pitch}, at ${seconds} seconds`,
  /** The toggle that shows every note's label as an ordered list (US-8.2). */
  'tab.noteList': 'Note list view',
  /** The ← shortcut's description in the keyboard shortcuts dialog. */
  'tab.shortcutPrevNote': 'Previous note',
  /** The → shortcut's description in the keyboard shortcuts dialog. */
  'tab.shortcutNextNote': 'Next note',
  /** The Tab screen's Esc shortcut's description in the keyboard shortcuts dialog. */
  'tab.shortcutClearSelection': 'Clear note selection',
  /** The `N` shortcut's description in the keyboard shortcuts dialog. */
  'tab.shortcutNextToCheck': 'Next note to check',
  /** A flagged (low-confidence) note's label: its label, then ", check this note" (US-6.2). */
  'tab.noteLabelCheck': (label: string) => `${label}, check this note`,
  /** The status line's note count: "1 note", "42 notes". */
  'tab.statusNotes': (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`,
  /** The status line's flagged count: "0 to check", "3 to check". */
  'tab.statusToCheck': (k: number) => `${k} to check`,
  /** The whole status line, as announced when it changes: "42 notes · 3 to check". */
  'tab.statusLine': (notes: string, toCheck: string) => `${notes} · ${toCheck}`,
  /** The button at the status line's right end (`N`). */
  'tab.nextToCheck': 'Next to check',
  /** Why Next to check is disabled. */
  'tab.nextToCheckNone': 'No notes to check',
  /**
   * The tuning-off warning (EXPERIENCE.md Tuning off): `cents` is the take's tuning offset;
   * shown rounded and unsigned, flat when negative.
   */
  'tab.tuningOff': (cents: number) =>
    `Your guitar seems about ${Math.round(Math.abs(cents))} cents ${cents < 0 ? 'flat' : 'sharp'} — tune up and record again for accurate tab`,
  /** The tuning-off warning's link to the Tuner. */
  'tab.openTuner': 'Open tuner',
  /** The drop-tuning warning (EXPERIENCE.md Drop tuning). */
  'tab.dropTuning': 'Looks like drop tuning — not supported in v1',
  /** The warning when every note is low-confidence (EXPERIENCE.md Every note uncertain). */
  'tab.allUncertain':
    'Every note is uncertain — check the input level and room noise, then re-analyse',
  /** The warning for a take that clipped (EXPERIENCE.md Too loud / too quiet; new copy). */
  'tab.clipped': 'This take clipped — move back or lower the input and record again',
  /** The tuning-off warning's Dismiss button's accessible name. */
  'tab.dismissTuning': 'Dismiss tuning warning',
  /** The drop-tuning warning's Dismiss button's accessible name. */
  'tab.dismissDropTuning': 'Dismiss drop tuning warning',
  /** The toast when a take stopped at the length cap opens (EXPERIENCE.md Recording near limit). */
  'tab.maxLengthReached': 'Maximum length reached',
  /** The toolbar's Bar lines toggle (EXPERIENCE.md Toolbar). */
  'tab.barLines': 'Bar lines',
  /** The playback group's accessible name (EXPERIENCE.md Playback). */
  'tab.playback': 'Playback',
  /** The Play/Pause button's accessible name while paused. */
  'tab.play': 'Play',
  /** The Play/Pause button's accessible name while playing. */
  'tab.pause': 'Pause',
  /** Why Play is disabled: the take's audio is gone (EXPERIENCE.md Audio deleted). */
  'tab.audioDeleted': 'Audio deleted',
  /** Why Play is disabled: the browser cannot play the take's audio file. */
  'tab.audioUnplayable': "Audio can't be played",
  /** A speed option's accessible name: "0.5 times speed" (the visible text is "0.5×"). */
  'tab.speedLabel': (speed: number) => `${speed} times speed`,
  /** The speed segmented control's accessible name. */
  'tab.speed': 'Playback speed',
  /** A speed option: "0.5×", "0.75×", "1×". */
  'tab.speedOption': (speed: number) => `${speed}×`,
  /** The playhead and the take's duration, each `m:ss`. */
  'tab.playbackTime': (current: string, duration: string) => `${current} / ${duration}`,
  /** Shortcut descriptions (the `?` dialog). */
  'tab.shortcutPlayPause': 'Play / pause',
  'tab.shortcutSeekToNote': 'Seek playback to selected note',
  /** The `0`–`9` shortcut's description (EXPERIENCE.md Interaction Primitives). */
  'tab.shortcutSetFret': 'Set fret; two digits within 400 ms make one number',
  /** The Ctrl/⌘+Z shortcut's description. */
  'tab.shortcutUndo': 'Undo',
  /** The Ctrl/⌘+Shift+Z and Ctrl+Y shortcuts' description. */
  'tab.shortcutRedo': 'Redo',
  /** An edit command's name (`model/edit-history.ts` `CommandLabel`), as undo and redo name it. */
  'tab.commandSetFret': (fret: number) => `Set fret ${fret}`,
  /** Announced after a fret edit: "Fret 5 on the G string". */
  'tab.editFret': (fret: number, string: StringNo) =>
    `Fret ${fret} on the ${TAB_STRING_NAMES[string]} string`,
  /** Announced after an undo: "Undid Set fret 5". */
  'tab.undone': (label: string) => `Undid ${label}`,
  /** Announced after a redo: "Redid Set fret 5". */
  'tab.redone': (label: string) => `Redid ${label}`,
  /** Announced assertively when an edit could not be made (the engine failed); nothing changed. */
  'tab.editFailed': "Couldn't change that note — try again",
  /** The ↑ / ↓ shortcuts' descriptions (EXPERIENCE.md Interaction Primitives). */
  'tab.shortcutStringUp': 'Move note to the next thinner string, same pitch',
  'tab.shortcutStringDown': 'Move note to the next thicker string, same pitch',
  /** The Delete / Backspace shortcut's description. */
  'tab.shortcutDelete': 'Delete note',
  /** The `I` shortcut's description. */
  'tab.shortcutInsert': 'Insert note after selection',
  /** The Enter shortcut's description. */
  'tab.shortcutConfirm': 'Confirm selected note (clears flag, locks it)',
  /** Command names (`CommandLabel`), as undo and redo name them: "Undid Move to string 3". */
  'tab.commandMoveString': (string: StringNo) => `Move to string ${string}`,
  'tab.commandDelete': 'Delete note',
  'tab.commandInsert': 'Insert note',
  'tab.commandConfirm': 'Confirm note',
  'tab.commandReanalyse': 'Re-analyse',
  'tab.commandTrim': 'Trim',
  'tab.commandResetTrim': 'Reset trim',
  /** The toolbar's Trim toggle and the Trim strip's heading (story "Trim"; EXPERIENCE.md Trim strip). */
  'tab.trim': 'Trim',
  /** The trim handles' accessible names. */
  'tab.trimStart': 'Trim start',
  'tab.trimEnd': 'Trim end',
  /** Announced politely after a handle stops moving: "Trim start 0:02.00". */
  'tab.trimMoved': (handle: string, time: string) => `${handle} ${time}`,
  /** The Trim strip's Save: saves the range and re-analyses it. */
  'tab.trimSave': 'Save',
  /** The Trim strip's Reset trim: re-analyses the full take. */
  'tab.trimReset': 'Reset trim',
  /** Shown in the waveform's place until its peaks arrive. */
  'tab.trimLoading': 'Loading waveform…',
  /** Shown in the waveform's place when its peaks could not be read. */
  'tab.trimWaveformFailed': "Couldn't load the waveform",
  /** The Confirm dialog's confirm button before a trim with an edited (locked) note shown. */
  'tab.trimConfirm': 'Trim and re-analyse',
  /** Announced when a trim (or a trim reset) run is cancelled, or failed: nothing changed. */
  'tab.trimCancelled': 'Trim cancelled',
  'tab.trimFailed': 'Trim failed — try again',
  /** Why Trim and Analysis settings are disabled while a run goes. */
  'tab.busyReanalysing': 'Busy re-analysing',
  'tab.busyTrimming': 'Busy trimming',
  /** Announced after a trim and after a trim reset committed. */
  'tab.trimmed': (n: number) => `Trimmed: ${n} ${n === 1 ? 'note' : 'notes'}`,
  'tab.trimResetDone': (n: number) => `Trim reset: ${n} ${n === 1 ? 'note' : 'notes'}`,
  /** Announced after a string move (EXPERIENCE.md Accessibility floor): "Moved to G string, fret 7". */
  'tab.editMoved': (string: StringNo, fret: number) =>
    `Moved to ${TAB_STRING_NAMES[string]} string, fret ${fret}`,
  /** Announced after a delete. */
  'tab.editDeleted': 'Note deleted',
  /** Announced after an insert: "Note inserted on the G string, fret 0". */
  'tab.editInserted': (string: StringNo, fret: number) =>
    `Note inserted on the ${TAB_STRING_NAMES[string]} string, fret ${fret}`,
  /** Announced after a confirm. */
  'tab.editConfirmed': 'Note confirmed',
  /**
   * Announced after an edit's own announcement when its re-fit re-fingered other notes
   * (EXPERIENCE.md Note (in tab)): "2 nearby notes re-fingered", "1 nearby note re-fingered".
   */
  'tab.refingered': (n: number) => `${n} nearby ${n === 1 ? 'note' : 'notes'} re-fingered`,
  /** The toolbar's Insert and Delete buttons (EXPERIENCE.md Toolbar). */
  'tab.insert': 'Insert',
  'tab.delete': 'Delete',
  /** The toolbar's Copy and Download buttons (EXPERIENCE.md Toolbar; CAP-18). */
  'tab.copy': 'Copy',
  'tab.download': 'Download',
  /** Copy's and Download's tooltips with no notes (No notes found; mockup tab.html). */
  'tab.noNotesToCopy': 'No notes to copy',
  'tab.noNotesToDownload': 'No notes to download',
  /** The toasts after Copy (or Ctrl/⌘+Shift+C): the tab is on the clipboard, or it is not. */
  'tab.copied': 'Tab copied',
  'tab.copyFailed': "Couldn't copy the tab",
  /** The toast when the browser refused the Download. */
  'tab.downloadFailed': "Couldn't download the tab",
  /** The Ctrl/⌘+Shift+C shortcut, as the `?` dialog lists it. */
  'tab.shortcutCopy': 'Copy tab',
  /** Insert's and Delete's tooltip with no notes (No notes found). */
  'tab.noNotesYet': 'No notes yet',
  /** Delete's tooltip with notes but none selected. */
  'tab.selectToDelete': 'Select a note to delete',
  /** The toolbar's Undo and Redo buttons (EXPERIENCE.md Toolbar). */
  'tab.undo': 'Undo',
  'tab.redo': 'Redo',
  /** Undo's and Redo's tooltips, naming the step: "Undo move to string 3", "Redo set fret 5". */
  'tab.undoAction': (label: CommandLabel) => `Undo ${commandPhrase(label)}`,
  'tab.redoAction': (label: CommandLabel) => `Redo ${commandPhrase(label)}`,
  /** Undo's and Redo's tooltips with nothing to undo or redo. */
  'tab.nothingToUndo': 'Nothing to undo',
  'tab.nothingToRedo': 'Nothing to redo',
  /** The edit popover (EXPERIENCE.md Fret popover): its name, the fret field's label. */
  'tab.popover': 'Edit note',
  'tab.popoverFret': 'Fret',
  /** The fret field's hint: the frets it accepts, "0 to 24". */
  'tab.popoverFretRange': (maxFret: number) => `0 to ${maxFret}`,
  /** A position button in the edit popover: "String 3, fret 7". */
  'tab.popoverPosition': (string: StringNo, fret: number) => `String ${string}, fret ${fret}`,
  /** The edit popover's position buttons' group name. */
  'tab.popoverPositions': 'Other strings',
  'tab.popoverConfirm': 'Confirm',
  'library.title': 'Library',
  /** The take list's accessible name. */
  'library.listLabel': 'Takes, newest first',
  /** Status badges (EXPERIENCE.md Library row). */
  'library.statusRecording': 'Recording',
  'library.statusNotAnalysed': 'Not analysed',
  'library.statusAnalysed': 'Analysed',
  /** A row's note count: "38 notes", "1 note". */
  'library.notes': (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`,
  /** A row's audio size: "0.2 MB" (`mb` already formatted to one place). */
  'library.size': (mb: string) => `${mb} MB`,
  'library.audioDeleted': 'Audio deleted',
  /** The metadata separator between date, duration, note count and size. */
  'library.metaSeparator': ' · ',
  /** The preview of a row with no notes or no analysis. */
  'library.noPreview': '—',
  /** Empty library (EXPERIENCE.md Library states). */
  'library.empty': 'No takes yet',
  'library.emptyRecord': 'Record',
  /** The first read of the library is running. */
  'library.loading': 'Loading takes…',
  /** A full read of the library failed. */
  'library.loadFailed': "Couldn't load your takes — reload the page to try again",
  /** The row menu (story 6.2; EXPERIENCE.md Library, mockup library.html). */
  'library.more': (title: string) => `More actions for ${title}`,
  'library.menu': (title: string) => `Actions for ${title}`,
  'library.rename': 'Rename',
  'library.deleteAudio': 'Delete audio only',
  'library.deleteTake': 'Delete take',
  /** The inline rename field. */
  'library.titleField': 'Take title',
  /** The Delete take dialog (EXPERIENCE.md :88). */
  'library.deleteTakeTitle': (title: string) => `Delete "${title}"?`,
  'library.deleteTakeBody':
    "Its tab and recording are removed from this computer. This can't be undone.",
  'library.deleteTakeConfirm': 'Delete take',
  /** The Delete audio only dialog. */
  'library.deleteAudioTitle': (title: string) => `Delete the audio of "${title}"?`,
  'library.deleteAudioBody':
    "Its recording is removed from this computer; the tab stays. This can't be undone.",
  'library.deleteAudioConfirm': 'Delete audio',
  /** A row action's write failed (a toast). */
  'library.renameFailed': "Couldn't rename the take",
  'library.deleteTakeFailed': "Couldn't delete the take",
  'library.deleteAudioFailed': "Couldn't delete the audio",
  /**
   * A row action refused because a backup or restore is running (a toast; story "Library
   * robustness during backup and restore").
   */
  'library.busyBackup': 'Wait for the backup to finish',
  'library.busyRestore': 'Wait for the restore to finish',
  /** The search field (story 6.3; EXPERIENCE.md Search): its name and placeholder. */
  'library.search': 'Search takes',
  /** No search matches (EXPERIENCE.md :116). */
  'library.noMatch': (query: string) => `No takes match "${query}"`,
  'library.clearSearch': 'Clear search',
  /** The search result count, announced once typing settles: "3 takes", "1 take". */
  'library.matchCount': (n: number) => `${n} ${n === 1 ? 'take' : 'takes'}`,
  /** Back up library (story 6.5; EXPERIENCE.md :85, mockup library.html (f·1)). */
  'library.backUp': 'Back up library',
  /** Shown over the progress bar while a backup runs. */
  'library.backingUp': 'Backing up…',
  /** The progress bar's value: "46%". */
  'library.backupPercent': (percent: number) => `${percent}%`,
  /** A toast and an assertive announcement when the backup failed. */
  'library.backupFailed': "Couldn't back up the library",
  /**
   * The banner offering a backup that finished after the player left the Library (story 7.17), with
   * Download (and Dismiss, `global.dismiss`): its take count and the time it finished ("9:14 pm").
   */
  'library.backupReady': (takes: number, time: string) =>
    `Your backup is ready — ${takes} ${takes === 1 ? 'take' : 'takes'}, made at ${time}`,
  'library.backupReadyDownload': 'Download',
  /** Announced once the backup has downloaded. */
  'library.backedUp': (n: number) => `Backed up ${n} ${n === 1 ? 'take' : 'takes'}`,
  /** A toast when some takes' audio is in a format this build cannot back up. */
  'library.backupUnsupported': (n: number) =>
    `${n} ${n === 1 ? 'recording' : 'recordings'} in an unsupported format ${n === 1 ? 'was' : 'were'} left out`,
  /** A toast when the backup downloaded but some takes' audio files were missing. */
  'library.backupMissing': (n: number) =>
    `Backed up — ${n} ${n === 1 ? 'recording was' : 'recordings were'} missing`,
  /** A toast when takes still recording (unfinished) were left out of the backup. */
  'library.backupUnfinished': (n: number) =>
    `${n} unfinished ${n === 1 ? 'take' : 'takes'} not backed up — open ${n === 1 ? 'it' : 'them'} from Record to recover`,
  /** Restore from backup (story 6.6; EXPERIENCE.md :85, :117, mockup library.html (f·2)). */
  'library.restore': 'Restore from backup',
  /** The Restore button's label while a restore reads or imports a file. */
  'library.restoring': 'Restoring…',
  /** The Restore dialog: the takes it will import, and the file's name. */
  'library.restoreTitle': (n: number, fileName: string) =>
    `Restore ${n} ${n === 1 ? 'take' : 'takes'} from ${fileName}?`,
  /** The Restore dialog's body; `skipped` takes in the file are already in the library. */
  'library.restoreBody': (skipped: number) =>
    skipped > 0
      ? `${skipped} ${skipped === 1 ? 'take' : 'takes'} already in your library ${skipped === 1 ? 'is' : 'are'} skipped; nothing is overwritten.`
      : 'Takes already in your library are skipped; nothing is overwritten.',
  'library.restoreConfirm': 'Restore',
  /** The summary toast (and polite announcement) once a restore finished. */
  'library.restored': (imported: number, skipped: number) =>
    `Imported ${imported} ${imported === 1 ? 'take' : 'takes'}` +
    (skipped > 0 ? `, skipped ${skipped} already in your library` : ''),
  /** The error banner when the picked file is not a valid backup (`backup-invalid`). */
  'library.restoreInvalid': "That file isn't a TabCreator backup — nothing was changed.",
  /** The error banner when a restore's write failed (storage full or failed). */
  'library.restoreFailed': "Restore didn't finish — nothing was changed.",
  /** The error banner when a restore failed and its rollback could not remove every file. */
  'library.restoreLeftFiles':
    "Restore didn't finish — some files were left behind and will be cleaned up the next time TabCreator opens.",
  /** Story 6.7: the one-time notice when the browser refused persistent storage. */
  'library.persistNotice':
    'Your browser may clear these takes when space runs low. Back them up regularly.',
  'library.persistNoticeDismiss': 'Dismiss storage notice',
  /** The footer: "23 takes · 41.0 MB used" (the MB from `formatMegabytes`). */
  'library.footer': (n: number, mb: string) => `${n} ${n === 1 ? 'take' : 'takes'} · ${mb} MB used`,
  'tuner.title': 'Tuner',
  /** The string name in display type; both E strings show "E". */
  'tuner.stringLetter': (string: StringNo) =>
    string === 1 || string === 6 ? 'E' : STRING_NAMES[string],
  'tuner.noPitch': '—',
  'tuner.noPitchHint': 'Play a single open string',
  /** The cents readout: "+12 cents", "−1 cents", "0 cents". */
  'tuner.cents': (cents: number) => `${signedCents(cents)} cents`,
  'tuner.sharp': '♯ Sharp — tune down',
  'tuner.flat': '♭ Flat — tune up',
  'tuner.inTune': 'In tune',
  /** The needle's accessible name; `cents` null is no pitch. */
  'tuner.needleLabel': (cents: number | null) =>
    `Tuning needle, −50 to +50 cents: ${cents === null ? 'No pitch detected' : `${signedCents(cents)} cents`}`,
  'tuner.chipsLabel': 'Strings tuned this session',
  /** A chip's accessible name: "Low E string, in tune", "A string, not yet tuned". */
  'tuner.chipLabel': (string: StringNo, ticked: boolean) =>
    `${STRING_NAMES[string]} string, ${ticked ? 'in tune' : 'not yet tuned'}`,
  /** Announced when a string enters In tune: "Low E string in tune". */
  'tuner.stringInTune': (string: StringNo) => `${STRING_NAMES[string]} string in tune`,
  'tuner.allInTune': 'All six strings in tune',
  'tuner.done': 'Done — go to Record',
  'settings.title': 'Settings',
  'settings.about': 'About',
  'settings.defaults': 'Defaults for new takes',
  'settings.defaultsHint':
    'New takes start with these values. Each take keeps its own copy in its Analysis settings.',
  'settings.engineVersion': (version: string) => `Engine v${version}`,
  'settings.engineVersionUnavailable': 'Engine version unavailable',
  /** Story 6.7: the Storage panel (mockup settings.html). */
  'settings.storage': 'Storage',
  'settings.storageProtected': 'Storage: protected',
  'settings.storageAtRisk': 'Storage: may be cleared by the browser',
  /** The link to the Library shown when storage is not protected. */
  'settings.storageBackUp': 'Back up library',
  /** Story "Theme toggle": the Appearance panel (mockup settings.html). */
  'settings.appearance': 'Appearance',
  /** The Theme segmented control's label, which names its button group. */
  'settings.theme': 'Theme',
  /** The segments: follow the operating system, or always light, or always dark. */
  'settings.themeSystem': 'System',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
} as const;

export type StringKey = keyof typeof strings;
