// OPFS (and backup zip) paths shared by the audio store, the backup and restore, and the backup
// worker. A leaf module with no imports, so sharing it pulls neither fflate, a worker nor the
// audio store into another bundle.

/** The directory of compressed audio, in OPFS and in a backup zip. */
export const AUDIO_DIR = 'audio';
