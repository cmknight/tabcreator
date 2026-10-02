import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Prefs } from '../../src/model/types';
import {
  DEFAULT_PREFS,
  loadPrefs,
  parsePrefs,
  PREFS_KEY,
  savePrefs,
  updatePrefs,
} from '../../src/storage/prefs';
import { fenceWrites, resetFenceForTests } from '../../src/storage/write-guard';

const CUSTOM: Prefs = {
  version: 1,
  micGranted: true,
  micDeviceId: 'dev-1',
  countIn: { on: true, bpm: 140 },
  analysisDefaults: { sensitivity: 0.7, minNoteMs: 60, maxFret: 20 },
  barLines: false,
  theme: 'dark',
  persistNoticeShown: true,
};

beforeEach(() => {
  localStorage.clear();
  resetFenceForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetFenceForTests();
});

describe('prefs', () => {
  it('uses the key tabcreator.prefs.v1 and has the typed defaults', () => {
    expect(PREFS_KEY).toBe('tabcreator.prefs.v1');
    expect(DEFAULT_PREFS).toEqual({
      version: 1,
      micGranted: false,
      micDeviceId: null,
      countIn: { on: false, bpm: 100 },
      analysisDefaults: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
      barLines: true,
      theme: 'system',
      persistNoticeShown: false,
    });
  });

  it('loads defaults when the value is missing', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['a non-object', '[1,2]'],
    ['null', 'null'],
    ['an older version', JSON.stringify({ ...CUSTOM, version: 0 })],
    ['a value with no version', JSON.stringify({ ...CUSTOM, version: undefined })],
  ])('loads defaults for %s', (_kind, stored) => {
    localStorage.setItem(PREFS_KEY, stored);
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips saved prefs', () => {
    savePrefs(CUSTOM);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual(CUSTOM);
    expect(loadPrefs()).toEqual(CUSTOM);
  });

  it('replaces each invalid field with its default and keeps the valid ones', () => {
    const stored = {
      ...CUSTOM,
      micGranted: 'yes',
      countIn: { on: true, bpm: 999 },
      analysisDefaults: { sensitivity: 2, minNoteMs: 60, maxFret: 30 },
      theme: 'neon',
    };
    expect(parsePrefs(JSON.stringify(stored))).toEqual({
      ...CUSTOM,
      micGranted: false,
      countIn: { on: true, bpm: 100 },
      analysisDefaults: { sensitivity: 0.5, minNoteMs: 60, maxFret: 24 },
      theme: 'system',
    });
  });

  it('returns a fresh object each time, so callers cannot mutate the defaults', () => {
    const a = loadPrefs();
    a.countIn.bpm = 200;
    expect(loadPrefs().countIn.bpm).toBe(100);
    expect(DEFAULT_PREFS.countIn.bpm).toBe(100);
  });

  it('loads defaults when localStorage is unreadable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('maps a quota failure to storage-full and other failures to storage-failed', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => savePrefs(CUSTOM)).toThrow(expect.objectContaining({ code: 'storage-full' }));
    setItem.mockImplementation(() => {
      throw new Error('weird');
    });
    expect(() => savePrefs(CUSTOM)).toThrow(expect.objectContaining({ code: 'storage-failed' }));
  });

  it('rejects saves with instance-taken once writes are fenced', () => {
    fenceWrites();
    let caught: unknown;
    try {
      savePrefs(CUSTOM);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('instance-taken');
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('updatePrefs writes only the patched fields over the stored prefs', () => {
    savePrefs({ ...DEFAULT_PREFS, theme: 'dark', countIn: { on: true, bpm: 90 } });
    const result = updatePrefs({ micGranted: true });
    const expected = {
      ...DEFAULT_PREFS,
      theme: 'dark',
      countIn: { on: true, bpm: 90 },
      micGranted: true,
    };
    expect(result).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual(expected);
  });

  it('updatePrefs starts from defaults when nothing is stored', () => {
    updatePrefs({ micGranted: true });
    expect(loadPrefs()).toEqual({ ...DEFAULT_PREFS, micGranted: true });
  });

  it('updatePrefs maps storage failures and fencing as savePrefs does', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => updatePrefs({ micGranted: true })).toThrow(
      expect.objectContaining({ code: 'storage-full' }),
    );
    setItem.mockRestore();
    fenceWrites();
    expect(() => updatePrefs({ micGranted: true })).toThrow(
      expect.objectContaining({ code: 'instance-taken' }),
    );
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });

  it('updatePrefs sanitises the patch, so it returns what loadPrefs reads back', () => {
    savePrefs(CUSTOM);
    const result = updatePrefs({
      countIn: undefined as unknown as Prefs['countIn'],
      analysisDefaults: { sensitivity: 5, minNoteMs: 60, maxFret: 20 },
    });
    expect(result).toEqual({
      ...CUSTOM,
      countIn: DEFAULT_PREFS.countIn,
      analysisDefaults: { sensitivity: 0.5, minNoteMs: 60, maxFret: 20 },
    });
    expect(loadPrefs()).toEqual(result);
  });
});
