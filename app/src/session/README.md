# session/ — one store per aggregate plus analysis.ts, instance-lock.ts (sole owner of Web Locks and BroadcastChannel) and app-reload.ts (spine AD-2, AD-3); may import model/, storage/, engine/ and audio/.

recording-session.ts composes its input derivations through input-derivation.ts: level-watch.ts (level warning), input-quality-watch.ts (input quality warning) and tuner-watch.ts (Tuner reading and ticks); none imports another or the store.

recording-recovery.ts is a module of recording-session.ts (story 3.11): the start-up recovery scan, Open and Discard of unfinished takes; the store composes it and publishes its list as `recovered`.

take-lifecycle.ts is a module of recording-session.ts: the take in progress and the recording state machine (start, count-in, chunks, length limits, failure stops, the save). take-save.ts holds what recording and recovery share: `MIN_TAKE_MS` and its one test `isTooShort`, the clip counter and the save step. The store's `isBusy()` is the one busy answer for its `beforeunload` guard and app-reload.ts.

instance-lock.ts gates the app on the Web Lock and hands it over (story 3.10); after a steal the new holder's recovery scan waits for the old holder's `released` message (story 5.3), with a 30 s fallback.
