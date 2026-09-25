# Wooclap Auto for Microsoft Edge

## Goal

The [question-type roadmap](docs/QUESTION_TYPES_ROADMAP.md) now records implementation status for every tile in the supplied screenshot. Sorting's media and required-comment findings are repaired. All 14 additional answer types support guarded application and submission for recognized layouts. The [remaining-types plan](docs/REMAINING_TYPES_PLAN.md) records the final seven implementations and their constraints. Live acceptance for these new types remains unverified. [Verification results](docs/VERIFICATION.md) record the current executed checks separately from implementation status.

Build an Edge extension that recognizes a Wooclap participant page, detects a new question, asks an AI for an answer, and selects/submits the answer. Users join events manually. Support a suggestion mode while validating the integration and an automatic mode for supported question layouts.

## Architecture

- Microsoft Edge Manifest V3 extension, written in TypeScript.
- Content adapters read visible question content and controls from the DOM. `wooclap.ts` handles choices/sorting and dispatches to `structured.ts` for text/fields, `remaining.ts` for contribution/image/scenario modules, and `advanced.ts` for rating/allocation and preview fallbacks. Observe changes and run a five-second backup check; debounce changes while content loads.
- An extension service worker owns the session, validates the tab and answers, and calls a local Node.js bridge.
- The bridge uses the OpenAI Responses API with a strict output schema selected for the answer family, then validates it against the question. The API key stays in a local environment file outside the extension. Bridge protocol 2 preserves legacy unversioned request support and clearly rejects incompatible explicit versions.
- When a question contains images, capture only its visible region. Pause if needed content is offscreen or if the monitored tab is inactive.
- Popup controls show status, current answer, request count, and a short activity log. An options page configures the bridge pairing token, model, mode, request limit, and optional DOM selectors.

## Detection and answer lifecycle

1. Validate HTTPS Wooclap hostname and supported participant controls; bind Start to one tab/event.
2. Read question text, choices or field definitions, visible constraints, selection rules, question ID if available, and image identifiers. Record whether the type allows automatic application or a preview only.
3. Build a stable fingerprint excluding timers, counters, selected state, and animation.
4. Allow one request per question occurrence. Repeated questions require a reliable identity or state boundary. Open-ended forms use a separate contribution policy so a cleared input or updated audience board cannot produce an additional answer.
5. Send normalized text and optional cropped image to the bridge. Treat page content as untrusted data, never executable instructions.
6. Validate the appropriate payload: selected IDs, ordered IDs, decimal/text values, field mappings, allocation totals, or normalized image points. Require complete answers and respect the review flag.
7. Re-read the current question and participant input snapshot before applying and submitting. Ignore stale answers, preserve participant edits, and cancel work when paused or navigated away. Preview-only families never trigger automatic application.
8. Verify submission from a known confirmation signal. If no reliable confirmation appears, stop and report uncertainty instead of retrying a click.

## Current question coverage

- Existing: single/multiple-choice questions, true/false, Poll, and text Sorting.
- New application/submission paths: Find a number, Open question, Word Cloud, Fill in the Blanks (text/custom dropdowns), Matching, Rating, and Prioritization.
- Remaining automatic paths: Brainstorming, Framework, Label an image, Find on image (one point), Drag and drop, Script concordance test, and SCT Judgment. Each verifies retained values or positions before one submission. Unknown variants retain manual previews/review. SCT preparation reads every custom scale description through local draft selections; existing selections are restored, while an initially unanswered scale keeps an unsubmitted first-position draft.
- Presentation activities are recognized as waiting/non-answer states. Organizer **Create using AI** needs no participant answer adapter.
- Matching uses unique destinations for the inspected native dropdown controls. The shared contract can represent reusable targets when a future observed layout supports them.

After updating, rebuild, restart the bridge, reload the extension at `edge://extensions`, and refresh the participant page. The extension requires protocol 2. Existing pairing tokens remain valid.

## Historical initial scope

- Single-answer multiple choice and true/false, plus multiple-answer controls where the selection behavior is explicit.
- Suggestion mode and explicit automatic mode.
- A local practice page and deterministic demo solver, clearly marked and restricted to practice questions.
- API timeouts, bounded requests, deduplication, strict loopback bridge authentication, and no screenshots or keys in activity logs.
- A semantic DOM adapter with optional selector overrides. Real Wooclap layout support must be validated against a test event; do not claim fixture tests prove live compatibility.

## Historical delivery stages

1. Save this plan, scaffold extension/bridge, and define shared contracts.
2. Implement detection and normalized question extraction with a practice fixture.
3. Implement structured AI answers and suggestion review.
4. Implement guarded selection, submission, cancellation, and status verification.
5. Run type checks, unit/integration tests, and browser tests with the loaded extension.
6. Validate a real participant event when a test URL/code is supplied; refine selectors as needed.
7. The originally deferred text/numeric and additional question families are now implemented at the capability levels above. Controlled live acceptance, additional layout variants, image overlays, and optional course materials remain future work.

## Acceptance checks

- Timer-only changes do not trigger new requests.
- Changed/reordered choices invalidate an in-flight answer.
- A closed question, event change, inactive tab, pause, and expired request cannot cause a stale submission.
- Unknown answers and ambiguous controls produce a review state.
- Decimal ranges, steps, and allocation totals use exact comparisons; required fields and image-label coverage must be complete.
- Participant edits invalidate a pending automatic application without changing the question fingerprint.
- Presentation activities and unsupported controls make no AI request; preview-only activities never submit automatically.
- A contribution form remaining open after success cannot cause a duplicate response.
- Submission is attempted once; missing confirmation does not cause a duplicate click.
- Demo answers can never be used for live Wooclap questions.
- Bridge rejects unauthenticated, oversized, malformed, and unexpected-origin requests.
- Real API accuracy, actual usage cost, and live Wooclap compatibility are reported separately from deterministic test results.

## Documentation references

- [Edge extension sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Visible-tab capture](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Wooclap multiple-choice questions](https://docs.wooclap.com/en/articles/8513348-mcq)

## Historical initial implementation status

- Complete: Edge extension build, popup/settings, DOM observer, five-second fallback, stable question identities, suggestion/automatic modes, cropped image capture, and guarded selection/submission.
- Complete: paired local OpenAI bridge, strict answer schema, cancellation, request limits, and practice-only demo solver.
- At initial delivery: 32 unit/integration tests, TypeScript/build checks, and actual Microsoft Edge browser tests, including screenshot capture and pause/resume regression coverage. This is a historical count; current results are in [verification results](docs/VERIFICATION.md).
- The initial version used only local practice testing and deterministic demo answers. Subsequent real API and source-based participant compatibility work is tracked below.

## Historical live compatibility and OpenAI integration phase

This phase was authorized on 2026-09-23. API credentials belong in `.env`; never copy them into the extension, test reports, or logs.

1. Inspect Wooclap's current public participant application and its browser-delivered assets. Record concrete routes, DOM selectors, selection behavior, and confirmation signals before changing the adapter. Do not use guessed selectors as evidence of compatibility.
2. Add a specific participant adapter where the observed interface differs from the generic accessible-control adapter. Keep question extraction separate from interaction, preserve choice order, and reject unsupported question types and ambiguous layouts.
3. Reproduce the observed participant structure with synthetic questions in test fixtures. Exercise it in Microsoft Edge, including SPA navigation, single/multiple selection, image choices, submission confirmation, and waiting/closed states.
4. Strengthen OpenAI response handling with deterministic SDK transport tests: valid answers, refusals, incomplete output, invalid choice IDs, authentication, quota/rate limits, timeouts, cancellation, and model errors. No automatic retries or demo fallback.
5. Run an explicit, small real API smoke test with synthetic text, multiple-answer, and image questions. Save only sanitized outcomes, latency, model, and token usage. Keep paid tests outside `npm test` and `npm run check`.
6. Validate the extension-to-bridge-to-OpenAI flow in Edge on local synthetic questions. Distinguish actual API verification, replayed Wooclap layout verification, and a real event submission in the final report.
7. Update setup instructions, live limitations, and verification results. A real participant event remains necessary to prove end-to-end live submission if no official test event is available.

### Completion criteria

- A documented, source-grounded live participant adapter with regression coverage.
- Explicit model error/review states instead of generic failures or guesses.
- Real OpenAI response validation with bounded calls, or an exact external blocker reported if credentials/model access fail.
- Updated unpacked Edge build and reproducible test commands.
- No real event submission claimed solely from local replay tests.

### Phase results (2026-09-23)

- Implemented `src/content/wooclap.ts` from the inspected public participant application: aliases, custom choices, asynchronous selection, separate submit, positive feedback, closed states, and meaningful images.
- Added SDK transport tests and precise sanitized failure messages; retained zero retries and API-key isolation.
- Added popup session-source and real-response model/timing/token metadata. Ready review answers keep their explanation and cannot be automatically submitted.
- Fixed cached-answer isolation between providers/models, repeated identical questions after submission, and pausing during asynchronous multi-choice selection.
- Passed 61 automated tests and the Microsoft Edge live-layout replay. Passed three direct real OpenAI questions and two through the Edge extension/bridge on the replay, using `gpt-4.1-mini`.
- At this phase's completion, development verification did not include a real Wooclap event submission. The user subsequently reported live MCQ success. This does not establish acceptance for additional types. See [compatibility evidence](docs/WOOCLAP_COMPATIBILITY.md) and [verification results](docs/VERIFICATION.md).

## Sorting support (2026-09-23)

Text sorting questions use stable item IDs and a complete ordered answer. The extension clicks visible move-up buttons, waits for each move, verifies the complete order, then submits once. Suggestions display numbered items. Reordering does not trigger another AI request; changed item text or IDs invalidate the answer. Media sorting and unrecognized controls require manual review.

The adapter follows the inspected public participant bundle: .Sorting, data-rbd-droppable-id=sorting, data-rbd-draggable-id, choice-text-<id>, and movement buttons with aria-controls and .fa-arrow-up. Those buttons use a 250 ms lift/move/drop cycle. No internal application state or answer keys are read.

At sorting's initial delivery, 67 automated tests passed, including ordered-answer SDK serialization, malformed permutations, asynchronous moves, cancellation, changed questions, and order changes before submission. This is a historical count. Later review reproduced two gaps that are now repaired: meaningful rendered images/SVGs stop text sorting, and unexpected comment fields are checked before dispatch. Actual live sorting acceptance remains unverified.

## Expanded question-type implementation (2026-09-24)

Implemented the contract foundation and capability matrix above: strict family-specific model outputs, shared answer validation, field/constraint fingerprints, one-contribution handling, participant-edit guards, family-specific popup previews, and protocol 2 compatibility checks. Model prompts require review when personal preferences or experiences were not supplied. The final seven implementations add category selection and own-contribution receipts, caption read-back, verified image placement, and complete custom SCT scale extraction. Unrecognized variants remain previews or review states.

Deterministic commands include `npm run check`, existing Edge regressions, and `npm run test:types`. The separate `npm run test:openai:types` command makes at most three paid requests for numeric, matching, and image-point output schemas; it is never invoked by ordinary tests. See [verification results](docs/VERIFICATION.md) for the latest results and whether that optional paid check was run.

Remaining validation: verify the new application paths in a controlled live event. Additional capabilities include multi-point responses, required SCT comment generation, image overlays, and unsupported geometry/layout variants. Keep local replay, real API response checks, and actual live acceptance as separate evidence.
