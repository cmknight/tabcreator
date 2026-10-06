// The Confirm dialog (story "Analysis settings and re-analysis"; DESIGN.md components.dialog,
// mockup settings.html .dialog): a `role="alertdialog"` centred on a scrim, at most 480 px wide,
// with a title, a body and two buttons, Cancel (first, focused on open) and the confirm action
// (secondary, never the default). Focus, the Tab trap and dismissal belong to
// `ui/a11y/overlays.ts`: Esc and a pointer-down on the scrim cancel, and focus returns to the
// opener on close. Reusable (the Library's deletes). `danger` gives the confirm button the danger
// style with the delete icon (DESIGN.md: danger always with icon and text); it is still never the
// default, and Cancel stays first and focused.

import { useId, useLayoutEffect, useRef } from 'react';
import { openOverlay } from '../a11y/overlays';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import styles from './ConfirmDialog.module.css';
import { DeleteIcon } from './icons';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm(): void;
  /** Cancel, Esc and a pointer-down on the scrim. */
  onCancel(): void;
  /**
   * Where focus returns on close (default: the element focused when it opened). A function is
   * asked at close, so it can pick the opener's replacement.
   */
  opener?: HTMLElement | null | (() => HTMLElement | null);
  /** A destructive action: the confirm button in the danger style, with the delete icon. */
  danger?: boolean;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  opener,
  danger = false,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef(onCancel);
  const returnTo = useRef(opener);
  useLayoutEffect(() => {
    cancel.current = onCancel;
    returnTo.current = opener;
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return openOverlay({
      element: el,
      opener: () => {
        const target = returnTo.current;
        if (target === undefined) return focused;
        return typeof target === 'function' ? target() : target;
      },
      initialFocus: cancelRef.current,
      onDismiss: () => cancel.current(),
    });
  }, []);

  return (
    <div className={styles.scrim} data-testid="confirm-scrim">
      <div
        ref={ref}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={bodyId} className={styles.body}>
          {body}
        </p>
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" className={buttons.secondary} onClick={onCancel}>
            {strings['global.cancel']}
          </button>
          <button
            type="button"
            className={danger ? `${buttons.secondary} ${buttons.danger}` : buttons.secondary}
            onClick={onConfirm}
          >
            {danger && <DeleteIcon className={buttons.icon} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
