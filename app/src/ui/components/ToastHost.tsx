import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
} from 'react';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import { CloseIcon } from './icons';
import { dismissToast, getToast, subscribeToast, TOAST_MS, type ShownToast } from '../toast';
import styles from './ToastHost.module.css';

/** Renders the current toast. Mount exactly once, in the shell. */
export function ToastHost() {
  const toast = useSyncExternalStore(subscribeToast, getToast);
  // Keyed by id: a replacement remounts, which restarts the timer and re-announces.
  return toast ? <ToastView key={toast.id} toast={toast} /> : null;
}

function ToastView({ toast }: { toast: ShownToast }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(TOAST_MS);
  const element = useRef<HTMLDivElement>(null);
  /** Where focus was before it entered the toast. */
  const returnTo = useRef<HTMLElement | null>(null);

  // Closing while focus is inside (action, replacement, timeout) would drop focus to <body>:
  // send it back where it came from, or to <main> if that element is gone. A layout-effect
  // cleanup runs before React removes the toast's DOM, so focus is still inside it here.
  useLayoutEffect(() => {
    const el = element.current;
    return () => {
      if (!el?.contains(document.activeElement)) return;
      const target = returnTo.current?.isConnected
        ? returnTo.current
        : document.querySelector<HTMLElement>('main');
      target?.focus();
    };
  }, []);

  // The toast element carries no aria-live (spine AD-18): its text goes through the announcer.
  // A silent toast (an update prompt offered again) is shown without announcing it.
  const silent = toast.silent === true;
  useEffect(() => {
    if (!silent) announce(toast.message);
  }, [toast.message, silent]);

  // Counts down only while neither hovered nor focused (WCAG 2.2.1), keeping the time left. A
  // persistent toast has no timer.
  const persistent = toast.persistent === true;
  useEffect(() => {
    if (persistent || hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(dismissToast, Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [persistent, hovered, focused]);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const from = e.relatedTarget;
    if (!e.currentTarget.contains(from as Node | null)) {
      returnTo.current = from instanceof HTMLElement ? from : null;
    }
    setFocused(true);
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };

  const { action, close } = toast;
  return (
    <div
      ref={element}
      className={styles.toast}
      data-testid="toast"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <p className={styles.message}>{toast.message}</p>
      {action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            dismissToast();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
      {persistent && (
        <button
          type="button"
          className={styles.close}
          aria-label={close?.label ?? strings['global.dismiss']}
          onClick={() => {
            dismissToast();
            close?.run();
          }}
        >
          <CloseIcon className={styles.closeIcon} />
        </button>
      )}
    </div>
  );
}
