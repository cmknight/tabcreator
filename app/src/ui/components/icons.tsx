// Shared status icons (DESIGN.md: icon + text, never colour alone). Decorative: the text beside
// each icon says what it means, so both are `aria-hidden`. Size and colour come from `className`.

/** The warning triangle: Too loud / Too quiet, near the take limit, warning banners. */
export function WarnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3 2 20h20z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The error circle: error banners (storage full, engine failed). */
export function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v6M12 16.5v.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** The pencil: the Tab screen's Rename take button. */
export function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Bar lines: the Tab toolbar's Bar lines toggle (two staff lines crossed by a bar). */
export function BarLinesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 8h18M3 16h18M12 4v16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Play: the Tab screen's Play/Pause button while paused (a right-pointing triangle). */
export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

/** Pause: the Tab screen's Play/Pause button while playing (two bars). */
export function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

/** Undo: an arrow curving back to the left (the mockup's `i-undo`). */
export function UndoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 7H4V2M4 7c2.2-2.5 5-4 8.5-4A8.5 8.5 0 1 1 5 16.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Redo: an arrow curving forward to the right (the mockup's `i-redo`). */
export function RedoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M15 7h5V2M20 7c-2.2-2.5-5-4-8.5-4A8.5 8.5 0 1 0 19 16.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Plus: the Tab toolbar's Insert button. */
export function InsertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Trash: the Tab toolbar's Delete button. */
export function DeleteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Analysis settings: the Tab toolbar's Analysis settings toggle (three slider lines). */
export function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Copy: the Tab toolbar's Copy button (two overlapping sheets; mockup tab.html `#i-copy`). */
export function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="8"
        y="8"
        width="12"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

/** Download: the Tab toolbar's Download button (an arrow into a tray; mockup `#i-download`). */
export function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v12M7 10l5 5 5-5M4 20h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Trim: the Tab toolbar's Trim toggle (scissors; mockup tab.html `#i-trim`). */
export function TrimIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8.5 7.5 20 18M8.5 16.5 20 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The tick: the Tuner's In tune and string chips, the Library's Analysed badge. */
export function CheckIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** More (three dots): the Library row's "⋯" menu button (the mockup's `i-more`). */
export function MoreIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="2" fill="currentColor" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <circle cx="19" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

/** Mute (a crossed-out speaker): the Library row menu's Delete audio only (the mockup's `i-mute`). */
export function MuteIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 9h4l5-4v14l-5-4H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Search (a magnifier): the Library's search field (the mockup's `i-search`). */
export function SearchIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Backup (an arrow into a tray): the Library's Back up library button (the mockup's `i-backup`). */
export function BackupIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v12M7 10l5 5 5-5M4 20h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Restore (an arrow out of a tray): the Library's Restore from backup button (the mockup's `i-restore`). */
export function RestoreIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15V3M7 8l5-5 5 5M4 20h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Close (×): a persistent toast's close button (ToastHost). */
export function CloseIcon({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
