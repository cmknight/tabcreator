// The Library's footer (story "Storage protection and Library states", 6.7; mockup library.html
// .libfoot): "23 takes · 41.0 MB used", the whole library's count even while searching. Library.tsx
// shows none for an empty library or an unknown usage.

import { formatMegabytes } from '../../../model/library';
import { strings } from '../../strings';
import libraryStyles from '../Library.module.css';

export function LibraryFooter({ takes, usageBytes }: { takes: number; usageBytes: number }) {
  return (
    <footer className={libraryStyles.footer} data-testid="library-footer">
      {strings['library.footer'](takes, formatMegabytes(usageBytes))}
    </footer>
  );
}
