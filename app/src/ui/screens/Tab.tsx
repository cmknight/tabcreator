import { strings } from '../strings';
import styles from './Screen.module.css';

export interface TabProps {
  takeId: string;
}

export function Tab({ takeId }: TabProps) {
  return (
    <section className={styles.screen} data-take-id={takeId}>
      <h1 className={styles.title}>{strings['tab.title']}</h1>
    </section>
  );
}
