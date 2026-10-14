# Background answering

Plan: 2026-09-30. Continue the selected Wooclap session while another tab is active or its Edge window is minimized, including visual questions. Preserve all question, input, cancellation, budget, and submission checks.

## Approach

1. Add a **Keep answering in the background** setting, off by default. Existing settings keep foreground behavior. Suggestion mode still waits for approval; automatic mode submits supported answers.
2. Use a debugger connection only to the monitored, supported tab during a background session. `Emulation.setFocusEmulationEnabled` maintains the page's rendering/timers without activating its tab or restoring its window. Keep DOM extraction and interactions in the existing content adapters.
3. Capture that tab through `Page.captureScreenshot`, then crop the question with the existing viewport geometry. Never capture the unrelated foreground tab as a fallback. Keep screenshots transient and recheck question identity and geometry before using them.
4. Make visibility checks conditional on the session's background setting. Page departure, navigation, closure, participant edits, Pause, stale questions, and uncertain submission still stop work. A debugger disconnect stops monitoring immediately.
5. Save the original `autoDiscardable` flag before protecting the monitored tab. Serialize attachment/cleanup, restore its original value on stop/failure, and recover stale cleanup records on worker restart. Restarted workers remain paused, preserving the request ledger.
6. Require Edge/Chromium 118 or newer: active debugger sessions keep the extension worker alive. Keep the existing five-second backup scan and DOM observer; the interval is best effort, not a timing guarantee. Browser/OS shutdown or sleep is outside this feature.

## Browser permission and controls

The debugger permission must be declared in the manifest; Chromium does not permit it as an optional runtime permission. Reloading the updated extension may require accepting its changed permissions. Background mode remains an explicit setting. Edge displays its debugging banner while the connection is active. Canceling the connection pauses answering; DevTools or another debugger may prevent attachment. The extension never activates another tab or changes the window's minimized state.

## Validation

- Settings migration, opt-in persistence, and explanatory UI.
- Unit checks for failed/canceled attachment, original tab-flag restoration, cleanup/recovery, and tab-specific capture.
- Loaded Edge extension: delayed answers across tab switches, consecutive hidden questions, current image pixels from the monitored tab, minimized answering, idle worker survival, explicit pause, disconnect/navigation cleanup, and no duplicate request after an interrupted send.
- Existing foreground, image, sorting, and expanded-type regressions. Tests use local fixtures and deterministic solvers, with no paid API calls or live Wooclap submissions.

## Sources

- [Debugger permission cannot be optional](https://developer.chrome.com/docs/extensions/reference/api/permissions).
- [Active debugger sessions keep workers alive from Chromium 118](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
- [Tab-targeted debugger API and detach events](https://developer.chrome.com/docs/extensions/reference/api/debugger).
- [Page screenshot protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).
- [Focus emulation implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/emulation_handler.cc).

## Implemented result

Implemented the opt-in setting, popup indication, session-only debugger ownership, tab-specific screenshot capture, conditional visibility guards, immediate page-departure cancellation, preserved discard settings, and stale-session cleanup. Original foreground behavior remains the default.

The new Edge replay passes nine checks using seven local solver calls. It verifies current screenshot pixels from the monitored tab while another tab is active and while Edge reports the window minimized, plus a 37-second idle interval with no extension polling. This is an isolated headless Edge test, not a manually observed desktop-window or live Wooclap acceptance test. The project check passes 193 tests, TypeScript, and the build. See [verification details](VERIFICATION.md) for all results.
