// The app's Reload buttons (Settings' and the Tab screen's engine-failed banners): a reload goes
// through session/app-reload.ts, which refuses while the app is busy (`isAppBusy`), and a refusal
// says why in a toast (story 5.2), so the press is never silently ignored.

import { reloadApp } from '../session/app-reload';
import { strings } from './strings';
import { showToast } from './toast';

/**
 * Reload: refused while a take is recorded, saved or analysed (story 5.6), or a recovered take
 * rebuilt; a toast then says why.
 */
export function reloadOrExplain(reload: () => boolean = reloadApp): void {
  if (!reload()) showToast({ message: strings['global.reloadBusy'] });
}
