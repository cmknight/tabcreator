import { lazy, Suspense, type ReactNode } from 'react';
import styles from './App.module.css';
import { routeToHash, useHash, useRoute, type Route } from './ui/router';
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

// Dev-only test page (spine: `#/__test/*` routes are gated on import.meta.env.DEV). Production
// builds replace the condition with `false`, so the page and its route string tree-shake out.
const StorageTestPage = import.meta.env.DEV ? lazy(() => import('./dev/StorageTestPage')) : null;

export function App() {
  const hash = useHash();
  if (import.meta.env.DEV && StorageTestPage && hash === '#/__test/storage') {
    return (
      <Suspense fallback={null}>
        <StorageTestPage />
      </Suspense>
    );
  }
  return <Shell />;
}

function Shell() {
  const route = useRoute();
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
                    aria-current={route.name === item.route.name ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className={styles.main}>{renderScreen(route)}</main>
    </>
  );
}
