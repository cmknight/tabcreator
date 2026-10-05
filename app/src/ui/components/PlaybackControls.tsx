// The Tab screen's playback group (story "Playback with a following cursor", US-6.5;
// EXPERIENCE.md Playback; DESIGN.md Playback controls): the hidden `<audio>` element, Play/Pause
// (the screen's only Play control; `button-secondary` with an icon), the speed segmented control
// (0.5× / 0.75× / 1×, `aria-pressed`) and the playhead / duration in numeric type. With no audio,
// Play is disabled with "Audio deleted" as its tooltip and accessible description; speed stays
// enabled; audio the browser cannot play disables it with "Audio can't be played". The state is `ui/use-playback.ts`'s.

import { useId } from 'react';
import hidden from '../a11y/visually-hidden.module.css';
import { formatElapsed } from '../format';
import { strings } from '../strings';
import { SPEEDS, type Playback } from '../use-playback';
import buttons from './buttons.module.css';
import { PauseIcon, PlayIcon } from './icons';
import styles from './PlaybackControls.module.css';

export function PlaybackControls({ playback }: { playback: Playback }) {
  const reasonId = useId();
  const { attachAudio, status, playing, speed, currentMs, durationMs, toggle, setSpeed } = playback;
  const reason =
    status === 'none'
      ? strings['tab.audioDeleted']
      : status === 'error'
        ? strings['tab.audioUnplayable']
        : null;
  return (
    <div
      role="group"
      aria-label={strings['tab.playback']}
      className={styles.playback}
      data-testid="tab-playback"
    >
      <audio ref={attachAudio} preload="auto" hidden data-testid="tab-audio" />
      <span title={reason ?? undefined}>
        <button
          type="button"
          className={`${buttons.secondary} ${styles.play}`}
          aria-label={playing ? strings['tab.pause'] : strings['tab.play']}
          disabled={status !== 'ready'}
          aria-describedby={reason !== null ? reasonId : undefined}
          onClick={() => toggle()}
        >
          {playing ? <PauseIcon className={styles.icon} /> : <PlayIcon className={styles.icon} />}
        </button>
      </span>
      {reason !== null && (
        <span id={reasonId} className={hidden.visuallyHidden}>
          {reason}
        </span>
      )}
      <div role="group" aria-label={strings['tab.speed']} className={styles.speeds}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={`${buttons.secondary} ${buttons.toggle} ${styles.speed}`}
            aria-pressed={speed === s}
            aria-label={strings['tab.speedLabel'](s)}
            onClick={() => setSpeed(s)}
          >
            {strings['tab.speedOption'](s)}
          </button>
        ))}
      </div>
      <span className={styles.time} data-testid="tab-playback-time">
        {strings['tab.playbackTime'](formatElapsed(currentMs), formatElapsed(durationMs))}
      </span>
    </div>
  );
}
