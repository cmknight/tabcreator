// DOM selectors shared by the shortcut registry and the tab area, so both read focus the same way.

/** A text field: shortcuts never fire there, and a moved selection never pulls focus from it. */
export const TEXT_FIELD =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** The tab area (`role="application"`). */
export const TAB_AREA = '[role="application"]';

/** A note button: one inside the tab area. */
export const NOTE_BUTTON = `${TAB_AREA} [data-note-id]`;

/** A toolbar, which owns its arrow keys (ARIA toolbar pattern). */
export const TOOLBAR = '[role="toolbar"]';

/** The Trim strip (story "Trim"): its handles own their keys, so Tab screen shortcuts skip it. */
export const TRIM_STRIP = '[data-trim-strip]';
