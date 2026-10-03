import { useId, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import hidden from '../a11y/visually-hidden.module.css';
import { inputDisplayName } from '../format';
import { strings } from '../strings';
import styles from './MicSelect.module.css';

/**
 * The Microphone select (EXPERIENCE.md Microphone select; mockup record.html): the listed audio
 * inputs, the live one selected. Hidden when there is one input or none. Choosing another
 * input switches the live input (and so the meter's source) at once. Reusable on Tuner.
 * From the count-in until the take is saved (any recording state but `idle`) it is `disabled`,
 * with the reason as the field's tooltip (a disabled select gets no hover events of its own)
 * and as visually hidden text the select is described by.
 */
export function MicSelect() {
  const { devices, activeDeviceId, recording } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const id = useId();
  const reasonId = useId();
  const busy = recording !== 'idle';
  if (devices.length <= 1) return null;
  // With no listed device active, an empty placeholder stays selected, so choosing any listed
  // device is a change (a controlled select would otherwise show the first one as chosen).
  const listed = devices.some((d) => d.deviceId === activeDeviceId);
  return (
    <div className={styles.field} title={busy ? strings['global.microphoneBusy'] : undefined}>
      <label className={styles.label} htmlFor={id}>
        {strings['global.microphone']}
      </label>
      <select
        id={id}
        className={styles.select}
        value={listed ? (activeDeviceId ?? '') : ''}
        disabled={busy}
        aria-describedby={busy ? reasonId : undefined}
        onChange={(e) => void recordingSession.selectMic(e.currentTarget.value)}
      >
        {!listed && <option value="" disabled />}
        {devices.map((device, i) => (
          <option key={device.deviceId} value={device.deviceId}>
            {inputDisplayName(device.label, i + 1)}
          </option>
        ))}
      </select>
      {busy && (
        <span id={reasonId} className={hidden.visuallyHidden}>
          {strings['global.microphoneBusy']}
        </span>
      )}
    </div>
  );
}
