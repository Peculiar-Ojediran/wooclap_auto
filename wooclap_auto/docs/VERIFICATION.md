# Verification results

## NVIDIA and shared fallback (2026-10-14)

- TypeScript, extension build, and **259 tests** pass. NVIDIA adapter tests cover all 12 answer-schema families, inline images, validation, refusals/truncation, sanitized errors, cancellation, and complete-body deadlines.
- Offline Edge standalone replay: **8 checks, 13 mocked provider requests**. All three providers work directly, including screenshot answers while minimized. No bridge or real provider call is involved.
- Offline Edge hosted replay: **11 checks, 19 mocked requests**. Verified no-key default routing, own-key priority, no fallback after personal-key authentication failure, fixed NVIDIA model, no personal-key/cookie forwarding, minimized screenshot routing, invalid answers, quotas, and cancellation. The temporary fixture does not change the packaged URL.
- The actual Worker bundle runs in Miniflare/workerd with a SQLite Durable Object. Two mocked NVIDIA calls succeed across a runtime restart; a third exceeds the persistent shared quota. Worker-specific fetch options were verified in this runtime, beyond build-only checks.
- A real Edge network-header probe confirmed GET health fetches omit Origin and JSON POST solves send the extension Origin. Public health returns only readiness metadata; solve retains the allowlist and persistent budgets.
- Existing credential consent/lifetime/isolation replay passes (9 checks, 2 local calls). Background/minimized replay passes (9 checks, 7 local calls), plus Wooclap choice/sorting and the expanded question-type replay.
- The included service is **not deployed**; the normal package has no hosted URL and reports this accurately. A real NVIDIA key, live model latency/accuracy, and live Wooclap acceptance are **not verified**. No paid API calls were made for this change.

See [NVIDIA plan](NVIDIA_FALLBACK_PLAN.md) and [operator deployment](HOSTED_FALLBACK.md).


Standalone operation verified on 2026-10-13 using Microsoft Edge on Windows. Earlier feature and paid API checks are dated separately below. The extension is built in `dist/edge`.

## Standalone direct API mode (2026-10-13)

- `npm run check` passed **232 tests**, TypeScript, and the extension build. New coverage executes the actual browser provider bundle without Node globals, verifies browser opt-in/headers, image validation, cancellation, rate/concurrency limits, default migration, URL boundaries, and the standalone settings workflow.
- `npm run test:standalone` passed **8 checks** in an isolated headless **Microsoft Edge 155.0.4283.45** profile. The browser was offline, port 4318 had no listener, and worker fetch used injected provider responses. **10 simulated provider requests, zero paid requests.**
- The replay verifies missing-key guidance without bridge access; administrative message rejection from the packaged practice page; offline demo suggestions and submissions; both providers' request headers/schema/credential isolation; cache reuse and provider separation; refusal/invalid-answer rejection; cancellation; inactive-tab answering; and direct visual requests while Edge is minimized.
- The packaged page loads its own external scripts under extension CSP. Only this extension's practice URL is accepted. Wooclap scripts still cannot read storage or invoke settings/key commands; the static packaged practice page is a trusted extension page, whose administrative runtime messages are also rejected.

This validates extension behavior and request construction with synthetic keys, not a real provider account or live Wooclap vote. [Standalone plan](STANDALONE_PLAN.md).

## Claude and extension keys (2026-10-13)

- `npm run check` passed **221 tests**, TypeScript, and the extension build. Claude uses injected Messages transports to verify structured text/image requests, all answer schema families, validation, refusals, truncated responses, sanitized errors, cancellation, and complete-body deadlines. No paid provider requests were made.
- `npm run test:credentials` passed **9 checks** in an isolated headless **Microsoft Edge 155.0.4283.45** profile, with **2 simulated provider requests**. Both provider keys route through the authenticated bridge and are removed from the solver's question payload.
- Edge verification confirms session-only defaults; metadata-only status and empty password fields; denied persistence permission; remembered-key persistence across browser restart; session-key removal on restart; replacement that revokes persistence; and Forget clearing both stores. Content scripts cannot read either storage area or change credentials through extension messages.
- Background tests also cover cancellation during startup and serialized Save/Forget commands while tab cleanup is delayed. Changing keys clears cached suggestions without reopening consumed request claims.
- Existing practice-page, screenshot capture, Wooclap choice/sorting, expanded question types, and background/minimized-window replays passed with synthetic answers. Reports remain under `test-results/`, including `credentials-replay.json`.

These checks do **not** verify a real Claude account, live Claude answer accuracy, or live Wooclap acceptance. No live Claude call or participant event was used for this verification. Environment API keys remain supported without being copied into extension storage. See [the implementation plan](PROVIDERS_AND_KEYS_PLAN.md).

## Current checks

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm run check` | Passed: 259 tests, TypeScript, extension build | Standalone and bridge transports, credential consent/isolation, legacy and expanded contracts, extraction, controlled inputs, validation, cancellation, and popup behavior |
| `npm run test:browser` | Passed in Edge; 11 local solver calls | Practice-page suggestions, automatic answers, cache/pause/resume, timer deduplication, closed questions, tab changes, request limits, stale answers, uncertain submissions |
| `npm run test:images` | Passed in Edge | Toolbar permission, 726 x 569 question crop, image answer, and confirmed submission |
| `npm run test:wooclap` | Passed in Edge | Choice and sorting participant layouts, asynchronous controls, image capture, repeated occurrences, and model-specific cache invalidation |
| `npm run test:types` | Passed in Edge; 21 local solver calls | 18 type/layout/zoom cases plus five lifecycle checks; all seven final automatic paths, stale geometry, uncertain receipts, and preparation cancellation |
| `npm run test:background` | Passed in Edge; 9 checks, 7 local solver calls | Inactive-tab/minimized capture and submission, fresh image pixels, idle monitoring, cancellation, connection loss, and tab-setting restoration |
| `npm run test:credentials` | Passed in Edge; 9 checks, 2 local solver calls | Provider/key routing, explicit persistence consent, session lifetime, forgetting keys, and content-script isolation |
| `npm run test:standalone` | Passed in offline Edge; 8 checks, 13 mocked provider requests | No localhost dependency, bundled demo, direct provider requests, cancellation, and background/minimized visual answering |
| `npm run test:openai:types` (earlier expansion; not rerun for background mode) | Passed: 3 real requests | Numeric, matching, and image-point responses from `gpt-4.1-mini` using the new strict schemas |

Normal tests use synthetic responses and never load the API key. The explicit `test:openai:types` command loads local API configuration, makes at most three paid requests, and never retries. It checks the solver directly; the independent Edge replay checks extension-to-bridge interaction with deterministic responses. No new-type live Wooclap vote was submitted during verification. The final seven adapters reuse the existing validated answer schemas; no additional paid requests were made for their implementation.

## Background operation (2026-09-30)

The new replay loads the built extension in an isolated **headless Microsoft Edge 154.0.4258.37** profile, using a local practice page and deterministic solver. It switches the active tab to an unrelated magenta page and sets the browser window state to `minimized` through Edge's window API. This verifies Edge's background/minimized rendering path; it does not claim a separate manual headed-window or live Wooclap test.

- A delayed response and the following question submit with the unrelated tab still active.
- The solver's cropped screenshot contains the monitored question's blue triangle and zero magenta foreground pixels. After minimizing, the test changes the triangle to red and verifies the new red pixels, proving the frame is current.
- Monitoring survives 37 seconds without extension-page polling, then answers the next minimized question.
- Pause cancels a pending request, releases the connection, restores the original tab discard policy, and prevents a duplicate request after resume.
- A lost capture connection pauses without requesting AI or falling back to a screenshot of the foreground tab. Navigation also stops and cleans up the session. An originally disabled automatic-discard policy remains disabled after cleanup.
- Unit tests cover browser-triggered debugger cancellation, attachment/setup failures, stale screenshot results after reconnect, startup interrupted by Pause/settings/navigation, and duplicate Start requests.

Sanitized evidence: `test-results/background-replay.json`. No screenshots or request payloads are saved by this replay. Background mode is off by default and still requires an open Edge browser and running local bridge. [Plan, implementation, and browser API sources](BACKGROUND_MODE_PLAN.md).

## Expanded question types

The Edge replay routes the Wooclap URL to local source-based fixtures. It does not contact a live participant event.

- **Verified local submissions:** Find a number, Open question, Word Cloud, typed blanks, mixed dropdown/text blanks, Matching, Rating, Prioritization, Brainstorming, Framework, Label an image, Find on image, Drag and drop, Script concordance test, and SCT Judgment. These cover all 14 additional answer types. Image placement also passes at 125% and 90% browser zoom.
- **Verified fallback:** An unrecognized Find on image variant still offers a preview with application blocked. Legacy preview unit tests remain as coverage for incomplete or unsupported variants.
- **Lifecycle checks:** Cleared text forms, audience board updates, and disappearing point feedback do not produce another contribution. A human edit during a delayed controlled-input update pauses application and preserves the edit. Changed zoom after an image suggestion blocks placement. A matching post from another participant does not confirm our contribution, and resuming after that uncertain send never retries it. Pausing SCT preparation stops further scale events and AI requests. A presentation slide makes no AI request.
- **Unit and contract coverage:** Required fields, unknown and duplicate IDs, exact decimal bounds/steps, numeric values the page would round, matching destination restrictions, allocation totals, out-of-bounds image coordinates, stale dropdown options, pause/close during application, missing receipts, editable popup drafts, category menu changes, category-specific existing drafts, caption persistence after reopening markers, duplicate/ambiguous image pins, changed geometry, full custom SCT descriptions, and optional comment preservation. Category-menu cleanup also respects pause.
- **Sorting repairs:** Visually meaningful ARIA-hidden images, SVG diagrams, extra comment fields, and media inserted after answer generation stop application.

The participant-edit check exposed two browser-specific details during development: a controlled form can temporarily restore its previous value before committing an edit, and a programmatic native choice click can itself generate trusted input/change events. The extension now combines rendered input snapshots with trusted input-intent revisions. Final practice and new-type replays pass with this guard.

Current limits are in [WOOCLAP_COMPATIBILITY.md](WOOCLAP_COMPATIBILITY.md). The inspected matching controls enforce unique destinations; reusable-destination layouts require separate verification. Recognized visual layouts now perform and verify placement; unknown variants remain manual. Scenario preparation reads custom meanings through unsubmitted draft selections, restores an existing score, and leaves a first-position draft if the scale was initially unanswered. Required scenario comments and unsupported image geometry remain manual. Local replay is evidence of the implemented DOM contract, not proof of live server acceptance or general AI accuracy.

## Earlier real-response checks on 2026-09-24

| Synthetic question | Expected result | Model result | Reported tokens |
| --- | --- | --- | --- |
| 6 multiplied by 7 | 42 | Passed | 262 input / 23 output |
| Match France and Italy to capitals | Paris and Rome | Passed | 373 input / 69 output |
| Locate a red circle in a generated image | Near normalized (0.75, 0.25) | Passed within 0.08 per axis | 510 input / 91 output |

These checks preceded the final seven adapters and were not rerun. These three requests reported **1,145 input tokens and 183 output tokens** in total. This is usage, not a cost estimate or accuracy benchmark. The sanitized local report is `test-results/openai-types.json`; the current type replay is `test-results/types-replay.json`. Neither contains credentials. Test images contain only synthetic content; normal extension operation does not save screenshots to disk.

## Earlier verification

On 2026-09-23, the original implementation passed 61 tests, later expanded to 67 with sorting. The earlier explicit `test:openai` and `test:openai:browser` runs passed five synthetic real-API questions using `gpt-4.1-mini`, reporting 1,650 input and 207 output tokens. Those historical reports remain in `test-results/openai-smoke.json` and `test-results/openai-browser.json`. They were not rerun as paid checks for this expansion.

The user reports live multiple-choice answering works. Live acceptance of sorting and the new types remains unverified. After updating, restart the bridge with `npm start`, reload the unpacked extension at `edge://extensions`, refresh the participant page, and start a new monitoring session. The extension now requires bridge protocol version 2.
