import {
  lazy,
  Suspense,
  useSyncExternalStore,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import styles from './App.module.css';
import { instanceLock } from './session/instance-lock';
import { Announcer } from './ui/a11y/announcer';
import { ShortcutListener } from './ui/a11y/shortcuts';
import { InstanceScreen } from './ui/components/InstanceScreen';
import { MicErrorAnnouncer } from './ui/components/MicErrorAnnouncer';
import { MicNotices } from './ui/components/MicNotices';
import { RecordingAnnouncer } from './ui/components/RecordingAnnouncer';
import { ToastHost } from './ui/components/ToastHost';
import { parseRoute, routeToHash, useHash, useRoute, type Route } from './ui/router';
import { Library } from './ui/screens/Library';
import { Record } from './ui/screens/Record';
import { Settings } from './ui/screens/Settings';
import { Tab } from './ui/screens/Tab';
import { Tuner } from './ui/screens/Tuner';
import { strings } from './ui/strings';

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
    ])
  : null;

/** The dev-only test page for `hash`, or null (always null in production builds). */
function renderDevPage(hash: string): ReactNode {
  const Page = DEV_PAGES?.get(hash);
  return Page ? <Page /> : null;
}

/**
 * The instance gate (story 3.10, spine AD-6): the shell and every screen (all of which may write
 * storage) mount only while this tab holds the instance lock; otherwise the full-screen instance
 * notice replaces them, and nothing while the first request is pending.
 */
export function App() {
  const state = useSyncExternalStore(instanceLock.subscribe, instanceLock.getSnapshot);
  if (state === 'acquiring') return null;
  if (state !== 'held') return <InstanceScreen state={state} />;
  return <HeldApp />;
}

function HeldApp() {
  const hash = useHash();
  const devPage = renderDevPage(hash);
  if (devPage) {
    // Inside the shell, so the test page runs with the announcer and toast host mounted.
    return (
      <Shell current={null}>
        <Suspense fallback={null}>{devPage}</Suspense>
      </Shell>
    );
  }
  // An unknown hash shows Record while `useRoute` replaces it with #/record.
  return (
    <Shell current={parseRoute(hash)?.name ?? 'record'}>
      <RoutedScreen />
    </Shell>
  );
}

function RoutedScreen() {
  return renderScreen(useRoute());
}

/**
 * The app frame: top bar, main content, and the one announcer, shortcut listener and toast host
 * (spine AD-18).
 */
function Shell({ current, children }: { current: Route['name'] | null; children: ReactNode }) {
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
      <main className={styles.main} tabIndex={-1}>
        {children}
      </main>
      <Announcer />
      <ShortcutListener />
      <MicErrorAnnouncer />
      <MicNotices />
      <RecordingAnnouncer />
      <ToastHost />
    </>
  );
}
