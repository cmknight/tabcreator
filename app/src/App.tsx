import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  type RefObject,
} from 'react';
import styles from './App.module.css';
import { instanceLock } from './session/instance-lock';
import { recordingSession } from './session/recording-session';
import { Announcer } from './ui/a11y/announcer';
import { isOverlayOpen, subscribeOverlay } from './ui/a11y/overlays';
import { ShortcutListener } from './ui/a11y/shortcuts';
import banner from './ui/components/banner.module.css';
import { ErrorIcon } from './ui/components/icons';
import { InstanceScreen } from './ui/components/InstanceScreen';
import { MicErrorAnnouncer } from './ui/components/MicErrorAnnouncer';
import { MicNotices } from './ui/components/MicNotices';
import { RecordingAnnouncer } from './ui/components/RecordingAnnouncer';
import { ShortcutsDialogHost } from './ui/components/ShortcutsDialog';
import { ToastHost } from './ui/components/ToastHost';
import { parseRoute, routeToHash, useHash, useRoute, type Route } from './ui/router';
import { closeShortcutsDialog } from './ui/shortcuts-dialog';
import { Library } from './ui/screens/Library';
import { Record } from './ui/screens/Record';
import { Settings } from './ui/screens/Settings';
import { Tab } from './ui/screens/Tab';
import { Tuner } from './ui/screens/Tuner';
import { strings } from './ui/strings';
import { UpdatePrompt } from './ui/update-prompt';

const NAV = [
  { route: { name: 'record' }, label: strings['global.navRecord'] },
  { route: { name: 'library' }, label: strings['global.navLibrary'] },
  { route: { name: 'tuner' }, label: strings['global.navTuner'] },
  { route: { name: 'settings' }, label: strings['global.navSettings'] },
] as const satisfies readonly { route: Route; label: string }[];

function renderScreen(route: Route): ReactNode {
  switch (route.name) {
    case 'record':
      return <Record />;
    case 'tab':
      return <Tab key={route.takeId} takeId={route.takeId} />;
    case 'library':
      return <Library />;
    case 'tuner':
      return <Tuner />;
    case 'settings':
      return <Settings />;
  }
}

// Dev-only test pages by hash (spine: `#/__test/*` routes are gated on import.meta.env.DEV).
// Production builds replace the condition with `false`, so the pages and their route strings
// tree-shake out.
type DevPages = ReadonlyMap<string, LazyExoticComponent<ComponentType>>;
const DEV_PAGES: DevPages | null = import.meta.env.DEV
  ? new Map([
      ['#/__test/storage', lazy(() => import('./dev/StorageTestPage'))],
      ['#/__test/ui', lazy(() => import('./dev/UiTestPage'))],
      ['#/__test/library500', lazy(() => import('./dev/Library500Page'))],
    ])
  : null;

/**
 * The dev-only test page for `hash` (a `?query` after the path is the page's own), or null
 * (always null in production builds).
 */
function renderDevPage(hash: string): ReactNode {
  const Page = DEV_PAGES?.get(hash.split('?')[0]!);
  return Page ? <Page /> : null;
}

/**
 * The instance gate (story 3.10, spine AD-6): the shell and every screen (all of which may write
 * storage) mount only while this tab holds the instance lock; otherwise the full-screen instance
 * notice replaces them, and nothing while the first request is pending. A database upgrade
 * blocked while the recording store is busy (story 5.3) keeps the shell mounted, with the notice
 * as a banner, so Stop stays reachable; the full-screen notice follows once the take is saved.
 */
export function App() {
  const state = useSyncExternalStore(instanceLock.subscribe, instanceLock.getSnapshot);
  const busy = useSyncExternalStore(recordingSession.subscribe, recordingSession.isBusy);
  if (state === 'acquiring') return null;
  if (state === 'upgrade-blocked' && busy) return <HeldApp upgradeBlocked />;
  if (state !== 'held') return <InstanceScreen state={state} />;
  return <HeldApp upgradeBlocked={false} />;
}

function HeldApp({ upgradeBlocked }: { upgradeBlocked: boolean }) {
  const hash = useHash();
  const devPage = renderDevPage(hash);
  if (devPage) {
    // Inside the shell, so the test page runs with the announcer and toast host mounted.
    return (
      <Shell current={null} upgradeBlocked={upgradeBlocked}>
        <Suspense fallback={null}>{devPage}</Suspense>
      </Shell>
    );
  }
  // An unknown hash shows Record while `useRoute` replaces it with #/record.
  return (
    <Shell current={parseRoute(hash)?.name ?? 'record'} upgradeBlocked={upgradeBlocked}>
      <RoutedScreen />
    </Shell>
  );
}

function RoutedScreen() {
  return renderScreen(useRoute());
}

/** A route's identity for focus: its name, and the take for the Tab screen. */
function routeKey(route: Route | null): string | null {
  if (route === null) return null;
  return route.name === 'tab' ? `tab/${route.takeId}` : route.name;
}

/**
 * After a route change (a nav link, the app: Stop opening the Tab screen, back/forward) scrolls
 * the page to the top and moves focus to the new screen's h1 (`main h1`, `tabIndex={-1}`; `main`
 * if a screen has none). Not on the first load, not for the same route again (a nav link clicked
 * on its own screen keeps focus), and not for an unknown hash on its way to #/record. Every routed
 * screen renders its h1 in the commit that mounts it (Tab's through TakeHeader's fallback title).
 * The Keyboard shortcuts dialog closes on a route change; focus moves only once no overlay is
 * open, so it never leaves an open modal.
 */
function useRouteFocus(main: RefObject<HTMLElement | null>): void {
  const key = routeKey(parseRoute(useHash()));
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (key === null) return;
    const before = previous.current;
    previous.current = key;
    if (before === undefined || before === key) return;
    const focusScreen = () => {
      const root = main.current;
      if (!root) return;
      window.scrollTo(0, 0);
      (root.querySelector<HTMLElement>('h1') ?? root).focus({ preventScroll: true });
    };
    closeShortcutsDialog();
    if (!isOverlayOpen()) {
      focusScreen();
      return;
    }
    // The dialog closes on its next render; its release returns focus first, then this.
    const unsubscribe = subscribeOverlay(() => {
      if (isOverlayOpen()) return;
      unsubscribe();
      focusScreen();
    });
    return unsubscribe;
  }, [key, main]);
}

/**
 * The app frame: top bar, main content, and the one announcer, shortcut listener, toast host and
 * Keyboard shortcuts dialog host (spine AD-18). A route change focuses the new screen's h1.
 * `upgradeBlocked`: the update-blocked notice as an alert banner at the top of main (story 5.3).
 */
function Shell({
  current,
  upgradeBlocked,
  children,
}: {
  current: Route['name'] | null;
  upgradeBlocked: boolean;
  children: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);
  useRouteFocus(main);
  return (
    <>
      <header className={styles.topBar}>
        <div className={styles.inner}>
          <span className={styles.appName}>{strings['global.appName']}</span>
          <nav aria-label={strings['global.navLabel']}>
            <ul className={styles.navList}>
              {NAV.map((item) => (
                <li key={item.route.name}>
                  <a
                    className={styles.navLink}
                    href={routeToHash(item.route)}
                    aria-current={current === item.route.name ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      {/* tabIndex -1: the toast returns focus here when the element it came from is gone. */}
      <main ref={main} className={styles.main} tabIndex={-1}>
        {upgradeBlocked && (
          <div
            role="alert"
            className={`${banner.banner} ${banner.error} ${styles.upgradeBlocked}`}
            data-testid="upgrade-blocked-banner"
          >
            <ErrorIcon className={banner.icon} />
            <p className={banner.text}>{strings['global.instanceUpgradeBlocked']}</p>
          </div>
        )}
        {children}
      </main>
      <Announcer />
      <ShortcutListener />
      <MicErrorAnnouncer />
      <MicNotices />
      <RecordingAnnouncer />
      <ToastHost />
      <ShortcutsDialogHost />
      <UpdatePrompt />
    </>
  );
}
