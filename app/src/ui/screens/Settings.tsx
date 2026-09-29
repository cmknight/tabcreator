import { strings } from '../strings';
import styles from './Screen.module.css';

export function Settings() {
  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>{strings['settings.title']}</h1>
    </section>
  );
}
