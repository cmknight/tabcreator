---
title: 'Announcer and toast'
type: 'feature'
ticket: '3'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'cc4ef32437d9717f530a7d02716ed4adcd808932'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Toast actions are hard for keyboard users to reach before the 4 s auto-dismiss, and the announcement does not mention the action.
    evidence: |-
      ToastHost sits after <main>, so Tab from mid-screen does not reach it; no Escape or shortcut; announce() sends only the message. No toast in epic 2 has an action; AD-19's "Update available - Reload" toast will. Settle in US-8.2 (accessibility) with the update-toast story: e.g. no auto-dismiss when an action is present, a shortcut to the toast, and "<message>. <action> available" announcements.
    location: >-
      app/src/ui/components/ToastHost.tsx
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Stories 2.5–2.9 need to announce mic errors, meter warnings and tuner state to screen readers and to show confirmation toasts, but no shared live region or toast exists, and AD-18 forbids screens writing their own `aria-live` text.

**Approach:** Add `ui/a11y/announcer.ts` (the single polite and assertive live region, mounted once in the shell) and a toast (a `showToast` API plus one host in the shell, styled per DESIGN.md), proven by Vitest and a dev-only test page rendered inside the shell.

## Boundaries & Constraints

**Always:** AD-18: one live region pair for the whole app, mounted once in the shell; nothing else in the app sets `aria-live`. AD-12: colours only from `theme.css` tokens (toast background `--color-text`, foreground `--color-surface`); user-visible text from `ui/strings.ts`. DESIGN.md Toast: inverted, bottom-centre, auto-dismiss after 4 s, at most one optional action, soft shadow, rounded like buttons. EXPERIENCE.md: toasts are for confirmations only, never the only place an error appears. Toast text is announced through the announcer (polite); the toast element itself carries no `aria-live`. The 4 s timer pauses while the toast is hovered or holds focus (WCAG 2.2.1). Dev pages stay gated on `import.meta.env.DEV` and absent from `app/dist`.

**Never:** No shortcuts registry or overlays (`ui/a11y/shortcuts.ts`, `overlays.ts` belong to later epics). No toast or announcement call sites in Record, Tuner or stores (stories 2.5–2.9 add them). No stacking queue: a new toast replaces the current one.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Polite | `announce('Saved')` | text appears in the polite region | none |
| Assertive | `announce('Mic lost', 'assertive')` | text appears in the assertive region | none |
| Repeat | same message announced twice | region content is re-set so it is announced both times | none |
| One region | full app rendered | exactly one polite and one assertive live region in the DOM | none |
| Toast | `showToast({ message })` | toast shows bottom-centre; message announced politely; gone after 4 s | none |
| Toast action | `showToast({ message, action: { label, run } })` | action button reachable by Tab, Enter runs it and dismisses the toast | none |
| Pause | toast hovered or focused past 4 s | stays until hover/focus ends, then dismisses after the remaining time | none |
| Replace | second `showToast` while one is shown | first replaced, timer restarts | none |

</intent-contract>

## Code Map

Builds on 2.1 (`e5700b3`, done). `app/src/App.tsx`: `App` returns the dev `StorageTestPage` (lazy, `import.meta.env.DEV ? lazy(...) : null`) for `#/__test/storage` *outside* `Shell`, else `Shell` (header + `<main>`). `app/eslint.config.js` allows `dev/` imports only from `App.tsx` and only in the true branch of `import.meta.env.DEV ? … : …`. `app/src/ui/strings.ts` flat `as const`. `app/src/ui/screens/Settings.module.css` shows the existing raw-px radius style (DESIGN radius tokens are not emitted as custom properties). `app/tests/e2e/storage.dev.spec.ts` opens `#/__test/storage` and finds heading "Storage test page"; it must keep passing. `@axe-core/playwright` 4.13.0 is installed; `app/tests/e2e/mic-helpers.ts` shows its use.

- `app/src/ui/a11y/announcer.ts` -- new: `announce(message, politeness?)` and an `Announcer` component (two visually hidden regions).
- `app/src/ui/toast.ts`, `app/src/ui/components/ToastHost.tsx`, `ToastHost.module.css` -- new.
- `app/src/App.tsx` -- mount `Announcer` and `ToastHost` once in `Shell`; render dev pages inside `Shell`'s `<main>`, keyed by `#/__test/<name>`.
- `app/src/dev/UiTestPage.tsx` -- new dev page for the e2e.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/ui/a11y/announcer.ts` -- module-level subscribe/emit; `Announcer` renders `role="status" aria-live="polite"` and `role="alert" aria-live="assertive"` regions, visually hidden; repeats re-announce (clear, then set on the next frame).
- [x] `app/src/ui/toast.ts`, `ToastHost.tsx`, `ToastHost.module.css` -- `showToast`, `dismissToast`; host renders one toast, 4 s timer with pause on hover/focus, optional action button, announces via `announce`.
- [x] `app/src/App.tsx` -- mount both in `Shell`; dev routes `#/__test/storage` and `#/__test/ui` render inside `Shell` behind the existing DEV pattern.
- [x] `app/src/dev/UiTestPage.tsx` -- buttons: announce polite, announce assertive, show toast, show toast with action (action writes a result line).
- [x] `app/eslint.config.js`, `app/src/lint-rules.test.ts` -- `no-restricted-syntax` banning `JSXAttribute[name.name='aria-live']` in `src/**` except `src/ui/a11y/**` (AD-18); test that a screen file with it fails and `ui/a11y/announcer.ts`-located code passes. No existing file sets `aria-live` outside `ui/a11y/`.
- [x] `app/tests/unit/announcer.test.ts`, `app/tests/unit/toast.test.tsx` -- matrix rows Polite to Replace with fake timers.
- [x] `app/tests/e2e/a11y-plumbing.dev.spec.ts` -- One region, Toast, Toast action (keyboard Tab + Enter), axe with no serious or critical violations; `storage.dev.spec.ts` still passes.

**Acceptance Criteria:**
- Given the production build, when any route renders, then exactly one polite and one assertive live region exist, and `app/dist` contains no `__test`, `UiTestPage` or `StorageTestPage`.
- Given lint, when any file outside `app/src/ui/a11y/` sets an `aria-live` JSX attribute, then `pnpm lint` fails (a `no-restricted-syntax` rule, proven in `app/src/lint-rules.test.ts`).

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 25 findings — high 0, medium 4, low 17, false 4, maybe-false 0
- findings:
  - `low` `patch` (verif, other) toast present at first mount is announced before the Announcer subscribes — Announcer now mounts before ToastHost.
  - `low` `reject` (verif, other) dev pages' empty aria-current untested — dev-only; no user impact.
  - `low` `patch` (edge) first-mount announcement dropped — same fix.
  - `false` `reject` (edge) touch tap leaves the toast hovered forever — v1 targets desktop Chrome only (spec Constraints).
  - `medium` `patch` (edge) focus falls to body when a focused toast closes — focus restored to the previously focused element.
  - `low` `reject` (edge) alt-tab resumes the timer — the toast closing after the window loses focus is expected; rare.
  - `low` `reject` (edge) rAF paused in a hidden tab delays announcements — nobody hears a hidden tab; delivered on return.
  - `low` `reject` (edge) lint misses setAttribute and computed aria-live keys — the rule covers the JSX and createElement paths code uses.
  - `medium` `patch` (blind) focus lost on action or replace — same focus fix.
  - `medium` `defer` (blind) action toasts are hard to reach by keyboard before the 4 s dismissal — DESIGN mandates a 4 s toast with one action; no toast in this epic has an action; owner US-8.2 (accessibility) with AD-19's update toast.
  - `low` `defer` (blind) announcement omits the action — same deferred item.
  - `low` `reject` (blind) replacement toast under a stationary pointer is not paused — rare; fix adds hover probing.
  - `low` `reject` (blind) lint does not ban role=status/alert or output — EXPERIENCE's error card uses role=alert by design; the rule targets aria-live.
  - `low` `patch` (blind) toast wraps at about half the viewport — inset-based centring.
  - `low` `reject` (blind) hard-coded radius and height — DESIGN radius tokens are not emitted as custom properties (story 1.1).
  - `low` `patch` (blind) unmount test proves nothing — now asserts no further updates after unmount.
  - `low` `reject` (blind) no pre-mount queue or double-mount guard — Announcer mounts once at app start.
  - `low` `reject` (blind) live-region count loop duplicated in two specs — they cover different builds (production vs dev).
  - `low` `reject` (blind) route resolved twice; nested dev-page ternary — two dev pages; refactor sweep scope.
  - `false` `reject` (intent) strings.ts untouched — the components hold no user-visible text; callers supply it.
  - `low` `reject` (intent) repeat announcement not proven in a real screen reader — DOM-level proof is what the ticket asks for.
  - `medium` `defer` (intent) keyboard reach proven only on a layout arranged for it — same deferred item.
  - `false` `reject` (intent) pausable 4 s timer departs from the intent — WCAG 2.2.1, recorded in the plan.
  - `false` `reject` (intent) lint rule and shell restructure exceed the intent — both are plan tasks (AD-18 enforcement; dev pages inside the shell).
  - `low` `patch` (edge) `shownAt` taken after the click resolves — timestamp now taken before the click.

## Design Notes

API the later stories call (2.5 errors, 2.6 warnings, 2.7 unplug toast):

```ts
announce(message: string, politeness?: 'polite' | 'assertive'): void;
showToast(toast: { message: string; action?: { label: string; run: () => void } }): void;
```

Both are plain module functions so `ui/` components call them in response to store changes; stores do not import `ui/`.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0 (`~/.cargo/bin` on PATH)
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** AD-18 plumbing is in place for stories 2.5–2.9:
  - `ui/a11y/announcer.ts` is the single polite and assertive live region pair, mounted once in the shell. Repeats are re-announced.
  - `showToast` and `ToastHost` give an inverted, bottom-centre toast. It auto-dismisses after 4 s, pausing on hover or focus; it has at most one action, is announced politely, and returns focus to its source when it closes.
  - A lint rule bans `aria-live` outside `ui/a11y/`.
  - Dev pages now render inside the shell; `#/__test/ui` is new.
- **Files changed:**
  - `app/src/ui/a11y/announcer.ts`, `announcer.module.css`: the announcer.
  - `app/src/ui/toast.ts`, `app/src/ui/components/ToastHost.tsx`, `ToastHost.module.css`: the toast.
  - `app/src/App.tsx`: mounts both; dev routes inside the shell; `<main tabIndex={-1}>` as the focus fallback.
  - `app/src/dev/UiTestPage.tsx` (new), `StorageTestPage.tsx` (outer element is now a `div`).
  - `app/eslint.config.js`, `app/src/lint-rules.test.ts`: the `aria-live` ban.
  - Tests: `app/tests/unit/{announcer.test.ts,toast.test.tsx}`, `app/tests/e2e/a11y-plumbing.dev.spec.ts`, and `navigation.spec.ts` (one region pair per route).
- **Review:** 25 findings (medium 4, low 17, false 4). 5 fixes applied: focus return, Announcer before ToastHost, inset centring, a leak-proof unmount test, and the timing bound. 1 item deferred to US-8.2 (keyboard reach and announcement of toast actions). The rest were rejected with reasons in the Review Triage Log.
- **Follow-up review recommended:** false. One medium entry (focus return) was patched.
- **Verification:**
  - The full plan command exited 0: 321 Vitest tests, 32 Playwright tests.
  - `app/dist` has no `__test`, `UiTestPage`, `StorageTestPage` or `fakeMic`.
- **Residual risks:**
  - Programmatic focus on `<main>` may show the focus ring.
  - An announcement made before the Announcer mounts is dropped.
  - The lint rule does not catch `setAttribute('aria-live', …)` or implicit live roles.
