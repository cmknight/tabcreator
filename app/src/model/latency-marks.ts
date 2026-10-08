// The User Timing marks the recording latency checks read (story 3.5, Done when 1; the CAP-25
// states sweep). Set in every build; nothing in the app reads them. Shared by ui/a11y/shortcuts.ts
// (the keydown mark), audio/recorder.ts (the capture marks) and the production-lane e2e specs.

/** Set at a handled Space keydown on Record. */
export const RECORD_KEYDOWN_MARK = 'record-keydown';

/** Set when the main thread receives the worklet's `started` message. */
export const CAPTURE_START_MARK = 'record-capture-start';

/** Set when the main thread receives the worklet's `stopped` message. */
export const CAPTURE_STOP_MARK = 'record-capture-stop';
