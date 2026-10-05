import { describe, expect, it } from 'vitest';
import type { Note, Take } from '../../src/model/types';
import { takeWarnings } from '../../src/ui/components/TakeWarnings';

// Story "Flags, warnings and bar lines on screen": which warning banners a take calls for.

const TAKE = {
  id: 't1',
  title: 'Take',
  createdAt: '2026-10-04T10:00:00.000Z',
  status: 'analyzed',
  updatedAt: '2026-10-04T10:00:04.000Z',
} as Take;
const NOTE = { id: 'n0', lowConfidence: false } as Note;

const kinds = (take: Take, notes: readonly Note[] | null = [NOTE]) =>
  takeWarnings(take, notes).map((w) => w.kind);
const withCents = (tuningOffsetCents: number): Take => ({
  ...TAKE,
  warnings: { tuningOffsetCents, belowRangeNotes: 0 },
});

describe('takeWarnings', () => {
  it('tuning off from exactly 40 cents either way, not below', () => {
    expect(takeWarnings(withCents(-40), [NOTE])[0]?.text).toBe(
      'Your guitar seems about 40 cents flat — tune up and record again for accurate tab',
    );
    expect(takeWarnings(withCents(40), [NOTE])[0]?.text).toBe(
      'Your guitar seems about 40 cents sharp — tune up and record again for accurate tab',
    );
    expect(kinds(withCents(-39.9))).toEqual([]);
    expect(kinds(withCents(39.9))).toEqual([]);
  });

  it('no tuning warning with no warnings or a non-finite offset', () => {
    expect(kinds(TAKE)).toEqual([]);
    expect(kinds(withCents(Number.NaN))).toEqual([]);
    expect(kinds(withCents(Number.NEGATIVE_INFINITY))).toEqual([]);
    expect(
      kinds({ ...TAKE, warnings: { belowRangeNotes: 0 } as unknown as Take['warnings'] }),
    ).toEqual([]);
  });

  it('with no committed tab, only clipping', () => {
    const take: Take = {
      ...withCents(-50),
      clipped: true,
      warnings: { tuningOffsetCents: -50, belowRangeNotes: 3 },
    };
    expect(kinds(take, null)).toEqual(['clipped']);
    expect(kinds(take)).toEqual(['tuning', 'drop', 'clipped']);
  });
});
