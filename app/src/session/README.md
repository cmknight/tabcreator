# session/ — one store per aggregate plus analysis.ts, instance-lock.ts (sole owner of Web Locks and BroadcastChannel) and app-reload.ts (spine AD-2, AD-3); may import model/, storage/, engine/ and audio/.

recording-session.ts composes its input derivations through input-derivation.ts: level-watch.ts (level warning), input-quality-watch.ts (input quality warning) and tuner-watch.ts (Tuner reading and ticks); none imports another or the store.
