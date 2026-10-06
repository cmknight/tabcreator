// Story "Copy and Download on the Tab screen": the slug, the line endings, the platform helpers
// (ui/platform.ts, with stubbed DOM and clipboard) and the export glue (ui/tab-export.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportFileName,
  MAX_SLUG_LENGTH,
  slugify,
  withPlatformLineEndings,
} from '../../src/model/export-file';
import { toText } from '../../src/model/tab-render';
import type { Note, StringNo } from '../../src/model/types';
import {
  copyText,
  downloadBlob,
  downloadText,
  isWindowsPlatform,
  PICK_FOCUS_GRACE_MS,
  pickFile,
} from '../../src/ui/platform';
import { copyTab, downloadTab, tabExportText } from '../../src/ui/tab-export';
import { dismissToast, getToast } from '../../src/ui/toast';

let nextId = 0;
function note(string: StringNo, fret: number, startMs: number): Note {
  nextId += 1;
  return {
    id: `n${nextId}`,
    string,
    fret,
    startMs,
    endMs: startMs + 100,
    midi: 0,
    confidence: 1,
    locked: false,
    lowConfidence: false,
  };
}

/** Two seconds of notes at 100 bpm: several bars. */
function notes(): Note[] {
  return Array.from({ length: 24 }, (_, i) => note(((i % 6) + 1) as StringNo, i % 5, i * 300));
}

const take = {
  title: 'Morning riff',
  createdAt: new Date(2026, 9, 4, 9, 5).toISOString(),
  countInBpm: 100,
};

/** The tab lines of an export (after the header, blank separators dropped). */
function tabLines(text: string): string[] {
  return text
    .split('\n')
    .slice(4)
    .filter((l) => l !== '');
}

describe('slugify and exportFileName', () => {
  it('strips symbols and emoji into single hyphens', () => {
    expect(exportFileName('Blues / Riff 🎸 in A♯')).toBe('blues-riff-in-a.txt');
  });

  it('strips diacritics', () => {
    expect(exportFileName('Café Déjà')).toBe('cafe-deja.txt');
  });

  it('gives tab.txt when nothing is left', () => {
    expect(exportFileName('🎸🎸')).toBe('tab.txt');
    expect(exportFileName('')).toBe('tab.txt');
    expect(exportFileName(' -- ')).toBe('tab.txt');
  });

  it('keeps at most 60 characters, cut on a hyphen boundary', () => {
    const title = Array.from({ length: 20 }, () => 'riffs').join(' '); // 119 characters
    const slug = slugify(title);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).toBe(Array.from({ length: 10 }, () => 'riffs').join('-')); // 59 characters
    expect(slug.endsWith('-')).toBe(false);
  });

  it('cuts a 100-character title with no hyphen at 60', () => {
    const slug = slugify('a'.repeat(100));
    expect(slug).toBe('a'.repeat(60));
  });

  it('keeps an exact cut when a word ends at 60', () => {
    const title = `${'a'.repeat(60)} tail`;
    expect(slugify(title)).toBe('a'.repeat(60));
  });

  it('lowercases and keeps digits', () => {
    expect(slugify('  Take 12 — LIVE!! ')).toBe('take-12-live');
  });

  it('folds the letters NFD does not split: ß ø æ œ ł đ and their capitals', () => {
    expect(exportFileName("Søren's Straße")).toBe('soren-s-strasse.txt');
    expect(slugify('ß ø æ œ ł đ')).toBe('ss-o-ae-oe-l-d');
    expect(slugify('ẞ Ø Æ Œ Ł Đ')).toBe('ss-o-ae-oe-l-d');
    expect(slugify('Łódź Œuvre')).toBe('lodz-oeuvre');
  });

  it('suffixes a Windows reserved name with -tab', () => {
    for (const name of ['CON', 'prn', 'Aux', 'nul', 'com1', 'COM9', 'lpt1', 'lpt9']) {
      expect(exportFileName(name)).toBe(`${name.toLowerCase()}-tab.txt`);
    }
    expect(exportFileName('  Con! ')).toBe('con-tab.txt');
    // Only the whole slug: names that merely contain one are left alone.
    expect(exportFileName('con man')).toBe('con-man.txt');
    expect(exportFileName('com10')).toBe('com10.txt');
    expect(exportFileName('com0')).toBe('com0.txt');
  });
});

describe('withPlatformLineEndings', () => {
  it('uses \\r\\n on Windows and leaves \\n elsewhere', () => {
    expect(withPlatformLineEndings('a\nb\n', true)).toBe('a\r\nb\r\n');
    expect(withPlatformLineEndings('a\nb\n', false)).toBe('a\nb\n');
  });
});

describe('isWindowsPlatform', () => {
  it('prefers userAgentData.platform', () => {
    expect(
      isWindowsPlatform({ platform: 'Linux x86_64', userAgentData: { platform: 'Windows' } }),
    ).toBe(true);
    expect(isWindowsPlatform({ platform: 'Win32', userAgentData: { platform: 'macOS' } })).toBe(
      false,
    );
  });

  it('falls back to navigator.platform', () => {
    expect(isWindowsPlatform({ platform: 'Win32' })).toBe(true);
    expect(isWindowsPlatform({ platform: 'MacIntel' })).toBe(false);
    expect(isWindowsPlatform({ platform: '', userAgentData: { platform: '' } })).toBe(false);
  });
});

describe('the platform helpers', () => {
  const { createObjectURL, revokeObjectURL } = URL;
  afterEach(() => {
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('copyText writes to the clipboard, and rejects when it refuses', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await copyText('tab');
      expect(writeText).toHaveBeenCalledWith('tab');
      writeText.mockRejectedValueOnce(new Error('denied'));
      await expect(copyText('tab')).rejects.toThrow('denied');
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    // No clipboard at all (an insecure context): a rejection too.
    await expect(copyText('tab')).rejects.toThrow();
  });

  it('downloadText clicks a temporary link to a text/plain blob, then revokes it', async () => {
    vi.useFakeTimers();
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:x';
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadText('riff.txt', 'e|--0--|\n');
    const clicked = click.mock.contexts[0] as HTMLAnchorElement | undefined;
    expect(clicked).toBeDefined();
    expect(clicked!.download).toBe('riff.txt');
    expect(clicked!.getAttribute('href')).toBe('blob:x');
    expect(document.querySelector('a')).toBeNull(); // removed after the click
    expect(blob!.type).toBe('text/plain;charset=utf-8');
    expect(await blob!.text()).toBe('e|--0--|\n');
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('downloadBlob keeps the blob as given', () => {
    vi.useFakeTimers();
    const blob = new Blob(['zip'], { type: 'application/zip' });
    const create = vi.fn((b: Blob) => (b.size > 0 ? 'blob:y' : 'blob:empty'));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBlob('backup.zip', blob);
    expect(create).toHaveBeenCalledWith(blob);
  });

  it('pickFile resolves with the chosen file, or null on cancel', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const chosen = pickFile('.zip');
    let input = click.mock.contexts[0] as HTMLInputElement | undefined;
    expect(input!.type).toBe('file');
    expect(input!.accept).toBe('.zip');
    const file = new File(['x'], 'b.zip');
    Object.defineProperty(input!, 'files', { value: [file] });
    input!.dispatchEvent(new Event('change'));
    await expect(chosen).resolves.toBe(file);
    expect(document.querySelector('input')).toBeNull();

    const cancelled = pickFile('.zip');
    input = click.mock.contexts[1] as HTMLInputElement | undefined;
    input!.dispatchEvent(new Event('cancel'));
    await expect(cancelled).resolves.toBeNull();
    expect(document.querySelector('input')).toBeNull();
  });

  it('pickFile with no cancel event: the window regaining focus with no file settles null', async () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const picked = pickFile('.zip');
    let settled: File | null | undefined;
    void picked.then((f) => (settled = f));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(PICK_FOCUS_GRACE_MS - 1);
    expect(settled).toBeUndefined();
    expect(document.querySelector('input')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
    expect(document.querySelector('input')).toBeNull();

    // A file whose change arrives within the grace after the focus is kept.
    const chosen = pickFile('.zip');
    const input = click.mock.contexts[1] as HTMLInputElement;
    window.dispatchEvent(new Event('focus'));
    const file = new File(['x'], 'b.zip');
    Object.defineProperty(input, 'files', { value: [file] });
    await vi.advanceTimersByTimeAsync(100);
    input.dispatchEvent(new Event('change'));
    await expect(chosen).resolves.toBe(file);
    expect(document.querySelector('input')).toBeNull();
    // Its listener is gone: a later focus starts no timer.
    window.dispatchEvent(new Event('focus'));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the tab export', () => {
  afterEach(() => dismissToast());

  it('is toText over the given notes, with bar lines only while the toggle is on', () => {
    const shown = notes();
    expect(tabExportText(take, shown, true)).toBe(toText(take, shown));
    const off = tabExportText(take, shown, false);
    expect(off).toBe(toText({ title: take.title, createdAt: take.createdAt }, shown));
    for (const line of tabLines(off)) expect(line.slice(2, -1)).not.toContain('|');
    expect(
      tabLines(tabExportText(take, shown, true)).some((l) => l.slice(2, -1).includes('|')),
    ).toBe(true);
  });

  it('copyTab copies and toasts "Tab copied"', async () => {
    const copy = vi.fn(() => Promise.resolve());
    await copyTab('text', copy);
    expect(copy).toHaveBeenCalledWith('text');
    expect(getToast()?.message).toBe('Tab copied');
  });

  it('copyTab toasts "Couldn\'t copy the tab" when the write fails', async () => {
    await copyTab('text', () => Promise.reject(new Error('denied')));
    expect(getToast()?.message).toBe("Couldn't copy the tab");
  });

  it('downloadTab toasts "Couldn\'t download the tab" when the download throws', () => {
    downloadTab('Riff', 'text', false, () => {
      throw new Error('no object URL');
    });
    expect(getToast()?.message).toBe("Couldn't download the tab");
  });

  it('downloadTab names the file by slug; the text matches the copy but for Windows line endings', () => {
    const text = tabExportText(take, notes(), true);
    const download = vi.fn();
    downloadTab('Blues / Riff 🎸 in A♯', text, false, download);
    expect(download).toHaveBeenLastCalledWith('blues-riff-in-a.txt', text);
    downloadTab('Blues / Riff 🎸 in A♯', text, true, download);
    const [, windowsText] = download.mock.lastCall as [string, string];
    expect(windowsText).toBe(text.replace(/\n/g, '\r\n'));
    expect(windowsText.replace(/\r\n/g, '\n')).toBe(text);
  });
});
