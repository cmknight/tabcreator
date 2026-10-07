import { CountInControls } from '../components/CountInControls';
import { InputQualityBanner } from '../components/InputQualityBanner';
import { LevelMeter } from '../components/LevelMeter';
import { MicGate } from '../components/MicGate';
import { MicSelect } from '../components/MicSelect';
import { RecordButton } from '../components/RecordButton';
import { RecoveredTakeBanners } from '../components/RecoveredTakeBanner';
import { StorageFullBanner } from '../components/StorageFullBanner';
import { strings } from '../strings';
import styles from './Screen.module.css';
import recordStyles from './Record.module.css';

export function Record() {
  return (
    <section className={styles.screen}>
      {/* First, above the h1 and outside the gate: unfinished takes found at start (story 3.11). */}
      <RecoveredTakeBanners />
      {/* Above the h1: shown while storage is full, until space is freed (a delete). */}
      <StorageFullBanner />
      {/* First, above the h1 (mockup order); it renders only while the mic is live. */}
      <InputQualityBanner />
      {/* The h1 with "Tune first" at the row's right end (mockup record.html rec-head). */}
      <div className={recordStyles.head}>
        <h1 className={styles.title} tabIndex={-1}>
          {strings['record.title']}
        </h1>
        <a className={recordStyles.link} href="#/tuner">
          {strings['record.tuneFirst']}
        </a>
      </div>
      <MicGate>
        <MicSelect />
        <LevelMeter />
        <CountInControls />
      </MicGate>
      {/* Outside the gate, so it is one element whether or not the mic is live: without a live
          mic it shows disabled, described by the card's heading. */}
      <RecordButton />
    </section>
  );
}
