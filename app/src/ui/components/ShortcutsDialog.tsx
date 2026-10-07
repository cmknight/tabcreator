// The Keyboard shortcuts dialog (EXPERIENCE.md :89, Interaction Primitives; mockup settings.html
// .keys; DESIGN.md components.dialog): a `role="dialog"` centred on a scrim, at most 480 px wide,
// listing every shortcut in the registry (`ui/a11y/shortcuts.ts`, spine AD-18) grouped by where
// it works, one table per group, then the text-field note and one Close button, focused on open.
// Focus, the Tab trap, Esc and an outside pointer-down belong to `ui/a11y/overlays.ts`; focus
// returns to the opener on close. `ShortcutsDialogHost`, mounted once in the shell, renders it
// while `ui/shortcuts-dialog.ts` says it is open (`?`, or Settings' About button).

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { openOverlay } from '../a11y/overlays';
import { NOTE_BUTTON } from '../a11y/selectors';
import { shortcutGroups, type ShortcutGroup } from '../a11y/shortcuts';
import {
  closeShortcutsDialog,
  getShortcutsDialog,
  subscribeShortcutsDialog,
} from '../shortcuts-dialog';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import styles from './ShortcutsDialog.module.css';

export interface ShortcutsDialogProps {
  /** Close, Esc and a pointer-down outside. */
  onClose(): void;
  /** Where focus returns on close. */
  opener: HTMLElement | null;
  /** The groups to list (default: the registry's). */
  groups?: readonly ShortcutGroup[];
}

/**
 * Where focus returns: the opener; when it is gone and was a note button (a reflow re-created
 * it), the note button for the same note; otherwise (no opener: `?` pressed with focus on
 * <body>) the shell's `main`, its focus fallback (as for toasts).
 */
export function returnTarget(opener: HTMLElement | null): HTMLElement | null {
  if (opener?.isConnected) return opener;
  const noteId = opener?.getAttribute('data-note-id') ?? null;
  const note =
    noteId === null
      ? undefined
      : [...document.querySelectorAll<HTMLElement>(NOTE_BUTTON)].find(
          (el) => el.getAttribute('data-note-id') === noteId,
        );
  return note ?? document.querySelector<HTMLElement>('main');
}

export function ShortcutsDialog({ onClose, opener, groups }: ShortcutsDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  const returnTo = useRef(opener);
  useLayoutEffect(() => {
    close.current = onClose;
    returnTo.current = opener;
  });
  const shown = useMemo(() => groups ?? shortcutGroups(), [groups]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return openOverlay({
      element: el,
      opener: () => returnTarget(returnTo.current),
      initialFocus: closeRef.current,
      onDismiss: () => close.current(),
    });
  }, []);

  return (
    <div className={styles.scrim} data-testid="shortcuts-scrim">
      <div
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.title}>
          {strings['global.shortcutsTitle']}
        </h2>
        {/* Scrolls when the dialog is taller than the window, so it takes focus (a keyboard
            user scrolls it with the arrows). */}
        <div
          className={styles.body}
          tabIndex={0}
          role="region"
          aria-label={strings['global.shortcutsList']}
        >
          {shown.map((group) => (
            <table key={group.id} className={styles.keys}>
              <caption className={styles.caption}>{group.title}</caption>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.description}>
                    <th scope="row" className={styles.keyCell}>
                      {row.keys.map((key, i) => (
                        <Fragment key={key}>
                          {i > 0 && <span className={styles.or}>{strings['global.keyOr']}</span>}
                          <kbd className={styles.kbd}>{key}</kbd>
                        </Fragment>
                      ))}
                    </th>
                    <td className={styles.description}>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          <p className={styles.note}>{strings['global.shortcutsNote']}</p>
        </div>
        <div className={styles.actions}>
          <button ref={closeRef} type="button" className={buttons.secondary} onClick={onClose}>
            {strings['global.close']}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the dialog while it is open. Mount exactly once, in the shell. Unmounting it (the shell
 * replaced by the instance screen) closes the dialog, so it cannot come back with a stale opener.
 */
export function ShortcutsDialogHost() {
  useEffect(() => closeShortcutsDialog, []);
  const { open, opener } = useSyncExternalStore(
    subscribeShortcutsDialog,
    getShortcutsDialog,
    getShortcutsDialog,
  );
  return open ? <ShortcutsDialog opener={opener} onClose={closeShortcutsDialog} /> : null;
}
