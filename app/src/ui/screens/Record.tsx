import { strings } from '../strings';
import styles from './Screen.module.css';

export function Record() {
  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>{strings['record.title']}</h1>
    </section>
  );
}
