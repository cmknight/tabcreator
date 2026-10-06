// The Tab screen's Copy and Download (story "Copy and Download on the Tab screen", CAP-18): the
// export text is `toText` over the notes the screen shows, with bar lines only while the Bar
// lines toggle is on, as on screen. Copy and Download use the same text; the download has `\r\n`
// line endings on Windows. The toolbar buttons and the Ctrl/⌘+Shift+C shortcut both come here.

import { exportFileName, withPlatformLineEndings } from '../model/export-file';
import { toText } from '../model/tab-render';
import type { Note, Take } from '../model/types';
import { copyText, downloadText, isWindowsPlatform } from './platform';
import { strings } from './strings';
import { showToast } from './toast';

/** The export text: `toText` over the shown notes, bar lines only with the toggle on. */
export function tabExportText(
  take: Pick<Take, 'title' | 'createdAt' | 'countInBpm'>,
  notes: readonly Note[],
  barLines: boolean,
): string {
  const { title, createdAt, countInBpm } = take;
  return toText(
    { title, createdAt, ...(barLines && countInBpm !== undefined ? { countInBpm } : {}) },
    notes,
  );
}

/** Copies `text` and toasts "Tab copied", or "Couldn't copy the tab" when the write fails. */
export async function copyTab(
  text: string,
  copy: (text: string) => Promise<void> = copyText,
): Promise<void> {
  try {
    await copy(text);
  } catch {
    showToast({ message: strings['tab.copyFailed'] });
    return;
  }
  showToast({ message: strings['tab.copied'] });
}

/**
 * Downloads `text` as `<slug>.txt`, with `\r\n` line endings on Windows. A download that throws
 * (no object URL, a refused click) toasts "Couldn't download the tab".
 */
export function downloadTab(
  title: string,
  text: string,
  windows: boolean = isWindowsPlatform(),
  download: (fileName: string, text: string) => void = downloadText,
): void {
  try {
    download(exportFileName(title), withPlatformLineEndings(text, windows));
  } catch {
    showToast({ message: strings['tab.downloadFailed'] });
  }
}
