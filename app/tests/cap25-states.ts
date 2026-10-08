// CAP-25 states sweep (FR-22): every error and empty state gives a message and a way forward.
// The checklist is EXPERIENCE.md's State Patterns table, one entry per row (`state` is the row's
// first cell, exactly), plus SPEC CAP-25's "player left during analysis". Each entry names the
// tests that reach the state: `file` relative to app/tests/, `title` the literal title as written
// in source (the template text for a looped test), and `lane` the Playwright project (or `unit`)
// that runs it. Production-lane tests (`chromium`, `prod-mic`) come first where one exists; rows
// reachable only through dev hooks keep their dev tests, which the lane makes visible.
// tests/unit/cap25-states.test.ts checks this list against the table and the test sources.

export type Lane = 'chromium' | 'prod-mic' | 'subpath' | 'dev' | 'perf' | 'unit';

export interface MappedTest {
  /** Relative to app/tests/: `e2e/…` or `unit/…`. */
  file: string;
  /** The test's title literal as written in source (template text for a looped test). */
  title: string;
  lane: Lane;
}

export interface StateEntry {
  /** The State Patterns row's first cell, exactly (or the SPEC extra). */
  state: string;
  surface: string;
  tests: readonly MappedTest[];
  note?: string;
}

/** The one checklist entry that is not a State Patterns row: SPEC CAP-25's success list. */
export const SPEC_EXTRA_STATE = 'Player left during analysis';

/** The shared-mic note for rows naming the Tuner as well as Record. */
const TUNER_SHARED =
  'The Tuner shares the Record mic and meter code (MicGate, mic session, level meter), so the Record test stands for both surfaces.';

export const CAP25_STATES: readonly StateEntry[] = [
  {
    state: 'First visit, mic not yet allowed',
    surface: 'Record, Tuner',
    tests: [
      {
        file: 'e2e/mic-setup.spec.ts',
        title: 'Record shows the setup card and makes no getUserMedia call',
        lane: 'chromium',
      },
      {
        file: 'e2e/mic-setup.spec.ts',
        title: 'Tuner shows the setup card and makes no getUserMedia call',
        lane: 'chromium',
      },
    ],
  },
  {
    state: 'Mic denied / no device / in use',
    surface: 'Record, Tuner',
    tests: [
      {
        file: 'e2e/mic-errors.dev.spec.ts',
        title: '${name} shows the ${code} card; Try again recovers without a reload',
        lane: 'dev',
      },
      {
        file: 'e2e/tuner.dev.spec.ts',
        title: 'a denied request shows the denied card on the Tuner; Try again recovers',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Mic access lost mid-session',
    surface: 'Record, Tuner',
    tests: [
      {
        file: 'e2e/record.dev.spec.ts',
        title: 'revoke mid-take: the take is saved as mic-lost, then the lost card',
        lane: 'dev',
      },
      {
        file: 'e2e/mic-errors.dev.spec.ts',
        title: '${what} while live shows the lost card and closes the input',
        lane: 'dev',
      },
    ],
    note: TUNER_SHARED,
  },
  {
    state: 'Device unplugged',
    surface: 'Record, Tuner',
    tests: [
      {
        file: 'e2e/mic-select.dev.spec.ts',
        title: 'unplug of the active device with another left: switches with a toast, no lost card',
        lane: 'dev',
      },
      {
        file: 'e2e/record.dev.spec.ts',
        title:
          'unplug mid-take: the take is saved as mic-lost, a toast, the mic live on the other input',
        lane: 'dev',
      },
    ],
    note: TUNER_SHARED,
  },
  {
    state: 'Bluetooth / low-rate input',
    surface: 'Record, Tuner',
    tests: [
      {
        file: 'e2e/input-quality.dev.spec.ts',
        title: 'low rate: the banner shows above the h1, is announced politely and passes axe',
        lane: 'dev',
      },
      {
        file: 'e2e/input-quality.dev.spec.ts',
        title:
          'Tuner at 16 kHz: the banner shows above the Tuner h1, is announced, and Dismiss focuses the h1',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Too loud / too quiet',
    surface: 'Record, Tuner',
    tests: [
      {
        file: 'e2e/level-meter.dev.spec.ts',
        title:
          'level_too_hot shows Too loud within 200 ms of the first clipped frame, announced once',
        lane: 'dev',
      },
      {
        file: 'e2e/level-meter.dev.spec.ts',
        title: 'silence_60s shows Too quiet after 3 s, not before 2.9 s',
        lane: 'dev',
      },
      {
        file: 'e2e/tab-flags.dev.spec.ts',
        title: 'clipped: a take recorded too hot shows the clipping banner, with no Dismiss',
        lane: 'dev',
      },
    ],
    note: TUNER_SHARED,
  },
  {
    state: 'Recording near limit',
    surface: 'Record',
    tests: [
      {
        file: 'e2e/record.prod.spec.ts',
        title:
          'a take runs to the 5:00 cap, stops itself, and its compressed copy is at most 5 MB @slow',
        lane: 'prod-mic',
      },
      {
        file: 'e2e/record.dev.spec.ts',
        title:
          'near the cap: "30 seconds left" shows and is announced once; at the cap it stops and saves',
        lane: 'dev',
      },
      {
        file: 'e2e/tab-flags.dev.spec.ts',
        title: 'max length: the toast after the auto-stop; not after reopening the analysed take',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Take too short',
    surface: 'Record',
    tests: [
      {
        file: 'e2e/record.dev.spec.ts',
        title:
          'too short: a take stopped at once (under 0.5 s) is discarded with a toast; Record stays',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Recovered take',
    surface: 'Record',
    tests: [
      {
        file: 'e2e/recovery.prod.spec.ts',
        title:
          'reload mid-take on the production build: the banner; Open recovers the take and opens its Tab',
        lane: 'prod-mic',
      },
      {
        file: 'e2e/recovery.dev.spec.ts',
        title:
          'reload mid-take: the leave dialog, then the banner; Open rebuilds the take and opens its Tab',
        lane: 'dev',
      },
      {
        file: 'e2e/recovery.dev.spec.ts',
        title: 'Open with the re-encode failing: the take is rebuilt as WAV and analyses',
        lane: 'dev',
      },
      {
        file: 'e2e/decode.dev.spec.ts',
        title:
          'raw file gone, WAV-fallback copy: the take decodes and analyses (Recording retro A5)',
        lane: 'dev',
      },
      {
        file: 'unit/instance-lock.test.ts',
        title: 'the app-wide onHeld (scanWhenReady) scans once, when ready resolves',
        lane: 'unit',
      },
      {
        file: 'e2e/instance.dev.spec.ts',
        title:
          'steal mid-take: saved once as instance-lost; the lost page says so; the scan waits for released',
        lane: 'dev',
      },
    ],
    note: 'Already done before the sweep, mapped only: the onHeld scan wiring (instance-lock.test.ts, instance.dev.spec.ts) and the WAV fallback in a browser (decode.dev.spec.ts, recovery.dev.spec.ts).',
  },
  {
    state: 'No signal',
    surface: 'Tuner',
    tests: [
      {
        file: 'e2e/tuner.dev.spec.ts',
        title: 'open_strings on the Tuner ticks all six chips, In tune only after 500 ms in range',
        lane: 'dev',
      },
    ],
    note: 'The test checks "Play a single open string" in the gap between strings.',
  },
  {
    state: 'Analysing',
    surface: 'Tab',
    tests: [
      { file: 'e2e/a11y-matrix.spec.ts', title: 'Tab: analysing in progress', lane: 'chromium' },
      {
        file: 'e2e/analysis-resume.spec.ts',
        title: 'a reload mid-analysis analyses the take again on load, and it completes',
        lane: 'chromium',
      },
      {
        file: 'e2e/tab-states.dev.spec.ts',
        title:
          'Cancel mid-analysis shows Analyse within 200 ms; the take stays recorded; Analyse then completes',
        lane: 'dev',
      },
    ],
    note: 'Cancel is pressed in a11y-matrix.spec.ts and its outcome checked in tab-states.dev.spec.ts.',
  },
  {
    state: 'Engine failed to load',
    surface: 'Tab, Settings',
    tests: [
      {
        file: 'e2e/engine.spec.ts',
        title: 'a wasm that fails to load shows the engine-failed banner with Reload',
        lane: 'chromium',
      },
    ],
  },
  {
    state: 'Analysis failed',
    surface: 'Tab',
    tests: [
      {
        file: 'e2e/tab-states.dev.spec.ts',
        title:
          'a forced analysis error shows "Analysis failed — try again" with Retry; Retry succeeds',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'No notes found',
    surface: 'Tab',
    tests: [
      {
        file: 'e2e/tab-states.dev.spec.ts',
        title: 'a silent take shows "No notes found" with the three tips',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Every note uncertain',
    surface: 'Tab',
    tests: [
      {
        file: 'e2e/tab-flags.dev.spec.ts',
        title: 'all uncertain: every note flagged shows the all-uncertain banner, with no Dismiss',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Tuning off',
    surface: 'Tab',
    tests: [
      {
        file: 'e2e/tab-flags.dev.spec.ts',
        title: 'tuning: a take recorded 45 cents flat shows the tuning banner with Open tuner',
        lane: 'dev',
      },
      {
        file: 'e2e/tab-flags.dev.spec.ts',
        title: 'dismiss: a dismissed tuning banner is back when the take is reopened',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Drop tuning',
    surface: 'Tab',
    tests: [
      {
        file: 'e2e/tab-flags.dev.spec.ts',
        title: 'drop: a take in drop D shows the drop-tuning banner',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Audio deleted',
    surface: 'Tab, Library',
    tests: [
      {
        file: 'e2e/playback.dev.spec.ts',
        title: 'No audio: Play disabled with "Audio deleted"; Space does nothing',
        lane: 'dev',
      },
      {
        file: 'e2e/backup.dev.spec.ts',
        title:
          'three takes, one with its audio deleted: the zip holds the manifest as stored and byte-identical audio; progress shows meanwhile',
        lane: 'dev',
      },
      {
        file: 'e2e/restore.dev.spec.ts',
        title:
          'a re-zipped backup restores every take; a take whose audio is missing shows "Audio deleted" with no playback',
        lane: 'dev',
      },
    ],
    note: 'Library: the row shows "Audio deleted" after Delete audio only (backup.dev.spec.ts) and after a restore missing the audio (restore.dev.spec.ts, which also checks Play on its Tab).',
  },
  {
    state: 'Storage full',
    surface: 'Tab, Library',
    tests: [
      {
        file: 'e2e/record.dev.spec.ts',
        title:
          'storage full mid-take: saved as storage-full, the error banner with a Library link, mic live; the next take keeps it',
        lane: 'dev',
      },
      {
        file: 'e2e/tab-states.dev.spec.ts',
        title:
          'storage full on commit keeps the result; Retry saves it with no new engine run, then deletes the raw file',
        lane: 'dev',
      },
      {
        file: 'e2e/storage-states.dev.spec.ts',
        title:
          'a save failing storage-full shows the Library banner, also after navigating; renames keep it; a delete clears it',
        lane: 'dev',
      },
      {
        file: 'e2e/storage-states.dev.spec.ts',
        title: 'disk full mid-recording: a rename keeps both banners; deleting a take clears them',
        lane: 'dev',
      },
    ],
    note: 'Tab: record.dev.spec.ts and tab-states.dev.spec.ts. Library: storage-states.dev.spec.ts.',
  },
  {
    state: 'Storage may be cleared',
    surface: 'Library, Settings',
    tests: [
      {
        file: 'e2e/storage-states.dev.spec.ts',
        title:
          'persist refused: asked once after the first save; the Library notice shows once, backs up, and is gone on a later visit',
        lane: 'dev',
      },
      {
        file: 'e2e/storage-states.dev.spec.ts',
        title: 'persist granted: Settings shows Storage: protected and the Library shows no notice',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Empty library',
    surface: 'Library',
    tests: [
      {
        file: 'e2e/library.dev.spec.ts',
        title: 'an empty library shows "No takes yet" and a Record button',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'No search matches',
    surface: 'Library',
    tests: [
      {
        file: 'e2e/library.dev.spec.ts',
        title:
          'search: accents and case ignored; no match and Clear search; live updates keep the query',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Restore failed',
    surface: 'Library',
    tests: [
      {
        file: 'e2e/restore.dev.spec.ts',
        title:
          'a backup restored into a fresh profile is byte-identical; again imports nothing; a truncated or format-2 file changes nothing',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Update available',
    surface: 'Global',
    tests: [
      {
        file: 'e2e/update.prod.spec.ts',
        title:
          'B waits: a plain reload still serves A, until Reload in the "Update available" toast',
        lane: 'prod-mic',
      },
      {
        file: 'e2e/update.prod.spec.ts',
        title:
          'an update while recording waits for Stop and analysis; Reload keeps a just-edited note',
        lane: 'prod-mic',
      },
    ],
  },
  {
    state: 'Offline',
    surface: 'Global',
    tests: [
      {
        file: 'e2e/offline.prod.spec.ts',
        title:
          'offline after one visit: the app loads from the service worker; record, analyse, edit, export',
        lane: 'prod-mic',
      },
    ],
    note: 'The offline flow also checks that no offline indicator, banner or alert shows (CAP-25 states sweep).',
  },
  {
    state: 'Unsupported browser',
    surface: 'App',
    tests: [
      {
        file: 'e2e/unsupported.spec.ts',
        title: 'without ${api}: only the unsupported notice, and nothing starts',
        lane: 'chromium',
      },
    ],
  },
  {
    state: 'Open in another tab',
    surface: 'App',
    tests: [
      {
        file: 'e2e/instance.dev.spec.ts',
        title: 'a second tab shows the notice; Use here moves the app; the first takes it back',
        lane: 'dev',
      },
    ],
  },
  {
    state: 'Update blocked',
    surface: 'App',
    tests: [
      {
        file: 'e2e/upgrade-blocked.spec.ts',
        title:
          'an old-version connection held open: the full-screen update-blocked notice, then the app once it closes',
        lane: 'chromium',
      },
      {
        file: 'e2e/instance.dev.spec.ts',
        title:
          'upgrade blocked during a take: the shell stays with the banner; Stop saves; then the notice',
        lane: 'dev',
      },
    ],
  },
  {
    state: SPEC_EXTRA_STATE,
    surface: 'Tab',
    tests: [
      {
        file: 'e2e/analysis-resume.spec.ts',
        title: 'a reload mid-analysis analyses the take again on load, and it completes',
        lane: 'chromium',
      },
      {
        file: 'e2e/analysis-resume.spec.ts',
        title: 'leaving for the Library mid-analysis and coming back: the analysis completes',
        lane: 'chromium',
      },
      {
        file: 'e2e/tab-states.dev.spec.ts',
        title: 'a reload mid-analysis analyses the take again on load, and it completes',
        lane: 'dev',
      },
    ],
  },
];
