import { lazy, Suspense, type ReactNode } from 'react';
import styles from './App.module.css';
import { Announcer } from './ui/a11y/announcer';
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

// Dev-only test pages (spine: `#/__test/*` routes are gated on import.meta.env.DEV). Production
// builds replace the condition with `false`, so the pages and their route strings tree-shake out.
const StorageTestPage = import.meta.env.DEV ? lazy(() => import('./dev/StorageTestPage')) : null;
const UiTestPage = import.meta.env.DEV ? lazy(() => import('./dev/UiTestPage')) : null;

export function App() {
  const hash = useHash();
  const DevPage = import.meta.env.DEV
    ? hash === '#/__test/storage'
      ? StorageTestPage
      : hash === '#/__test/ui'
        ? UiTestPage
        : null
    : null;
  if (DevPage) {
    // Inside the shell, so the test page runs with the announcer and toast host mounted.
    return (
      <Shell current={null}>
        <Suspense fallback={null}>
          <DevPage />
        </Suspense>
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

/** The app frame: top bar, main content, and the one announcer and toast host (spine AD-18). */
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
      <ToastHost />
    </>
  );
}
