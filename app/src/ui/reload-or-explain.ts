// The app's Reload buttons (Settings' and the Tab screen's engine-failed banners): a reload goes
// through session/app-reload.ts, which refuses while the app is busy (`isAppBusy`), and a refusal
// says why in a toast (story 5.2), so the press is never silently ignored. The reload first awaits
// the app-wide flush, so it resolves later (story "Update available prompt").

import { reloadApp } from '../session/app-reload';
import { strings } from './strings';
import { showToast } from './toast';

/**
 * Reload: refused while a take is recorded, saved or analysed (story 5.6), a recovered take
 * rebuilt, a Tab edit is still unsaved after the flush (or held for Retry), the flush times out,
 * or a library backup or restore runs; a toast then says why.
 */
export async function reloadOrExplain(
  reload: () => Promise<boolean> | boolean = reloadApp,
): Promise<void> {
  if (!(await reload())) showToast({ message: strings['global.reloadBusy'] });
}
