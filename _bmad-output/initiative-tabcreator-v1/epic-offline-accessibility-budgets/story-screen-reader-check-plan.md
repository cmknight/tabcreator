---
title: "Screen reader check"
ticket: 14
status: done
---

Manual check by the owner on a Windows device (macOS checks deferred; epic decision 2026-10-08).

## Results

| Check | Date | Result | Bugs |
|---|---|---|---|
| NVDA, record → analyse → edit → export and the note list | 2026-10-08 | Pass: note labels, edit announcements, analysis progress, recording start/stop, "Tab copied" and the note list all read correctly | none |
| Ctrl+Shift+C copies the tab (Library retro DS10) | 2026-10-08 | Pass in Chrome, Edge and Firefox on Windows; no browser clash, so no rebind needed | none |
| Installed app opens standalone (CAP-20) | 2026-10-08 | Pass: installed from Chrome, launched from the Start menu, opens in its own window with no address bar or tabs | none |
| Benchmark calibration (US-8.3) | 2026-10-08 | Done: laptop (Ryzen 7 5800H, WSL2) median 1351 ms; CI runner medians 839, 1193, 1203, 1492 ms (mean 1182 ms); `calibrationFactor` 1.14 in `app/benchmark.config.json` (commit 3dcf1f7) | none |

## Notes

- The calibration laptop is a 2021 high-end chip rather than a 2022 mid-range one; for this single-threaded analysis it is roughly comparable.
- The CI runner's speed varies by about ±30% between runs, so the gated value moves with it.
- The user-visible end-to-end time (open a 60 s take until its notes show, about 2.8 s) is outside this gate and stays an open question with the owner.
- VoiceOver and ⌘+Shift+C on macOS are deferred, so US-8.2's VoiceOver criterion stays open.
