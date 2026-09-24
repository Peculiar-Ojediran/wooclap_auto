# Verification results

Verified on 2026-09-24 using Microsoft Edge on Windows. The extension is built in `dist/edge`.

## Current checks

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm run check` | Passed: 124 tests, TypeScript, extension build | Legacy and expanded contracts, actual SDK parsing through injected transport, extraction, controlled input updates, validation, cancellation, and popup behavior |
| `npm run test:browser` | Passed in Edge; 11 local solver calls | Practice-page suggestions, automatic answers, cache/pause/resume, timer deduplication, closed questions, tab changes, request limits, stale answers, uncertain submissions |
| `npm run test:images` | Passed in Edge | Toolbar permission, 726 x 569 question crop, image answer, and confirmed submission |
| `npm run test:wooclap` | Passed in Edge | Choice and sorting participant layouts, asynchronous controls, image capture, repeated occurrences, and model-specific cache invalidation |
| `npm run test:types` | Passed in Edge; 16 local solver calls | 15 type/layout cases, participant-edit protection, presentation detection, and contribution deduplication |
| `npm run test:openai:types` | Passed: 3 real requests | Numeric, matching, and image-point responses from `gpt-4.1-mini` using the new strict schemas |

Normal tests use synthetic responses and never load the API key. The explicit `test:openai:types` command loads local API configuration, makes at most three paid requests, and never retries. It checks the solver directly; the independent Edge replay checks extension-to-bridge interaction with deterministic responses. No new-type live Wooclap vote was submitted during verification.

## Expanded question types

The Edge replay routes the Wooclap URL to local source-based fixtures. It does not contact a live participant event.

- **Verified local submissions:** Find a number, Open question, Word Cloud, typed blanks, mixed dropdown/text blanks, Matching, Rating, and Prioritization. The two blank layouts belong to one question type, so this adds seven automatic types.
- **Verified previews with application blocked:** Brainstorming, Framework, Label an image, Find on image, Drag and drop, Script concordance test, and SCT Judgment.
- **Lifecycle checks:** Returning to the same cleared contribution form makes no second request or submission. A human edit during a delayed controlled-input update pauses application and preserves the edit. A presentation slide makes no AI request.
- **Unit and contract coverage:** Required fields, unknown and duplicate IDs, exact decimal bounds/steps, numeric values the page would round, matching destination restrictions, allocation totals, out-of-bounds image coordinates, stale dropdown options, pause/close during application, missing receipts, and editable popup drafts.
- **Sorting repairs:** Visually meaningful ARIA-hidden images, SVG diagrams, extra comment fields, and media inserted after answer generation stop application.

The participant-edit check exposed two browser-specific details during development: a controlled form can temporarily restore its previous value before committing an edit, and a programmatic native choice click can itself generate trusted input/change events. The extension now combines rendered input snapshots with trusted input-intent revisions. Final practice and new-type replays pass with this guard.

Current limits are in [WOOCLAP_COMPATIBILITY.md](WOOCLAP_COMPATIBILITY.md). The inspected matching controls enforce unique destinations; reusable-destination layouts require separate verification. Visual previews show labels or normalized coordinates and do not perform placement. Scenario previews do not assume unavailable custom scale meanings. Local replay is evidence of the implemented DOM contract, not proof of live server acceptance or general AI accuracy.

## Real-response checks on 2026-09-24

| Synthetic question | Expected result | Model result | Reported tokens |
| --- | --- | --- | --- |
| 6 multiplied by 7 | 42 | Passed | 262 input / 23 output |
| Match France and Italy to capitals | Paris and Rome | Passed | 373 input / 69 output |
| Locate a red circle in a generated image | Near normalized (0.75, 0.25) | Passed within 0.08 per axis | 510 input / 91 output |

These three requests reported **1,145 input tokens and 183 output tokens** in total. This is usage, not a cost estimate or accuracy benchmark. The sanitized local report is `test-results/openai-types.json`; the current type replay is `test-results/types-replay.json`. Neither contains credentials. Test images contain only synthetic content; normal extension operation does not save screenshots to disk.

## Earlier verification

On 2026-09-23, the original implementation passed 61 tests, later expanded to 67 with sorting. The earlier explicit `test:openai` and `test:openai:browser` runs passed five synthetic real-API questions using `gpt-4.1-mini`, reporting 1,650 input and 207 output tokens. Those historical reports remain in `test-results/openai-smoke.json` and `test-results/openai-browser.json`. They were not rerun as paid checks for this expansion.

The user reports live multiple-choice answering works. Live acceptance of sorting and the new types remains unverified. After updating, restart the bridge with `npm start`, reload the unpacked extension at `edge://extensions`, refresh the participant page, and start a new monitoring session. The extension now requires bridge protocol version 2.
