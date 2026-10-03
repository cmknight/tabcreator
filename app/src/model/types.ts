// Shared types (stories: "Shared types"; spine AD-7, AD-14, AD-2). Every story uses these names.

export type StringNo = 1 | 2 | 3 | 4 | 5 | 6; // 1 = high e, 6 = low E
export const OPEN_MIDI: Record<StringNo, number> = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };

export interface AnalysisSettings {
  sensitivity: number; // 0..1, default 0.5
  minNoteMs: number; // default 40
  maxFret: number; // default 24
}

export interface DetectedNote {
  // engine output, before fret mapping
  startMs: number;
  endMs: number;
  midi: number;
  confidence: number; // 0..1
}

export interface Note extends DetectedNote {
  id: string; // crypto.randomUUID()
  string: StringNo;
  fret: number;
  locked: boolean;
  lowConfidence: boolean;
}

export type TakeStatus = 'recording' | 'recorded' | 'analyzed';

/**
 * Why a recording ended (spine take lifecycle: stop / mic lost / max length / storage full /
 * instance lost / recovery).
 */
export type StopReason =
  'user' | 'max-length' | 'mic-lost' | 'storage-full' | 'instance-lost' | 'recovered';

export interface Take {
  id: string;
  title: string;
  createdAt: string; // ISO 8601
  status: TakeStatus;
  durationMs: number;
  sampleRate: number;
  tuning: 'EADGBE';
  micLabel: string;
  audioMime: string | null; // null when audio deleted
  trimStartMs: number;
  trimEndMs: number | null;
  warnings?: { tuningOffsetCents: number; belowRangeNotes: number }; // from analysis (US-4.4); drives FR-24 warnings
  countInBpm?: number; // set only when the take was recorded with a count-in; drives bar lines
  clipped?: boolean; // the recording clipped; shown on the Tab screen (spine AD-14)
  stopReason?: StopReason; // how the recording ended; persisted so Record → Tab needs no handoff (spine AD-14)
  settings: AnalysisSettings;
  analysisVersion: string | null;
  updatedAt: string;
}

export interface Tab {
  takeId: string;
  notes: Note[];
  updatedAt: string;
  deletedStartMs: number[]; // start times of notes the user deleted; re-analysis never brings them back (US-4.6)
}

export interface AnalysisResult {
  // engine analyze() output
  notes: DetectedNote[];
  tuningOffsetCents: number; // median deviation of voiced frames from the A440 semitone grid
  belowRangeNotes: number; // voiced notes below E2 that were dropped (drop tuning or capo)
}

/** Input to the engine's `analyze` besides the PCM and sample rate (spine AD-7). Times are ms from untrimmed 0. */
export interface EngineAnalyzeInput extends AnalysisSettings {
  trimStartMs: number;
  trimEndMs: number | null;
  skipStartMs: number; // 100 when the take has countInBpm, else 0
}

export type ThemePref = 'system' | 'light' | 'dark';

/** Persisted preferences: localStorage key `tabcreator.prefs.v1`, owned by `storage/prefs.ts` (spine AD-2, AD-11). */
export interface Prefs {
  version: 1;
  micGranted: boolean;
  micDeviceId: string | null;
  countIn: { on: boolean; bpm: number }; // bpm 40–240, default 100
  analysisDefaults: AnalysisSettings;
  barLines: boolean;
  theme: ThemePref;
  persistNoticeShown: boolean;
}

/** The units allowed to write Take fields (spine AD-14). */
export type TakeWriter = 'recording-session' | 'take-session' | 'library-session' | 'restore';

/**
 * Which writer owns which Take fields (spine AD-14). `patchTake` throws in dev
 * builds when a patch touches a field its writer does not own. `updatedAt` is
 * stamped by `storage/db.ts` on every patch and owned by no patch writer.
 * `restore` writes whole records (including `updatedAt`) through `importTakes` only.
 */
export const TAKE_FIELD_OWNERS = {
  'recording-session': [
    'id',
    'createdAt',
    'micLabel',
    'sampleRate',
    'countInBpm',
    'settings',
    'tuning',
    'durationMs',
    'clipped',
    'stopReason',
    'audioMime',
    'status',
  ],
  'take-session': [
    'title',
    'settings',
    'trimStartMs',
    'trimEndMs',
    'warnings',
    'analysisVersion',
    'status',
  ],
  'library-session': ['title', 'audioMime'],
  restore: [
    'id',
    'title',
    'createdAt',
    'status',
    'durationMs',
    'sampleRate',
    'tuning',
    'micLabel',
    'audioMime',
    'trimStartMs',
    'trimEndMs',
    'warnings',
    'countInBpm',
    'clipped',
    'stopReason',
    'settings',
    'analysisVersion',
    'updatedAt',
  ],
} as const satisfies Record<TakeWriter, readonly (keyof Take)[]>;
