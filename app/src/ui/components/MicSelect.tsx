import { useId, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { strings } from '../strings';
import styles from './MicSelect.module.css';

/**
 * The Microphone select (EXPERIENCE.md Microphone select; mockup record.html): the listed audio
 * inputs, the live one selected. Hidden when there is one input or none. Choosing another
 * input switches the live input (and so the meter's source) at once. Reusable on Tuner.
 */
export function MicSelect() {
  const { devices, activeDeviceId } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const id = useId();
  if (devices.length <= 1) return null;
  // With no listed device active, an empty placeholder stays selected, so choosing any listed
  // device is a change (a controlled select would otherwise show the first one as chosen).
  const listed = devices.some((d) => d.deviceId === activeDeviceId);
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {strings['global.microphone']}
      </label>
      <select
        id={id}
        className={styles.select}
        value={listed ? (activeDeviceId ?? '') : ''}
        onChange={(e) => void recordingSession.selectMic(e.currentTarget.value)}
      >
        {!listed && <option value="" disabled />}
        {devices.map((device, i) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || strings['global.microphoneUnnamed'](i + 1)}
          </option>
        ))}
      </select>
    </div>
  );
}
