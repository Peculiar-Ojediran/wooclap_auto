# Wooclap question-type roadmap and implementation status

Original plan: 2026-09-23. Implementation status updated: 2026-09-24. All 14 additional types now have guarded application/submission for the recognized participant layouts. The [remaining-types implementation plan](REMAINING_TYPES_PLAN.md) covers the final seven paths. The sections explicitly marked **historical plan** preserve the proposed direction and release criteria; they are not claims that every planned interaction is complete. Current executed checks are recorded in [VERIFICATION.md](VERIFICATION.md).

## Current coverage

| Screenshot item | Current project status | Next work |
| --- | --- | --- |
| Multiple choice | Implemented for single and multiple answers, including true/false. User reports that live answering works. | Keep regression coverage during the contract migration. |
| Poll | Recognized by the existing choice adapter when the participant controls match the supported layout. No separate live Poll verification recorded. | Test Poll explicitly; distinguish factual prompts from personal preferences. |
| Sorting | Text ordering implemented; media/comment review findings repaired. Live sorting acceptance remains unverified. | Verify actual receipt in a controlled live event. |
| Additional answer types | All 14 application/submission paths; see the matrix below. | Verify live acceptance and additional layout variants separately. |
| Audio / Video, Slide, Timer, Spin the wheel | Recognized presentation/non-answer states. | Wait without an AI request; resume on the next supported question. |
| Create using AI | An organizer authoring action. | No participant answer adapter needed; recognize the generated question's actual type. |

Repeated tiles in the screenshot count once. Wooclap's [question-type catalog](https://docs.wooclap.com/en/collections/2357551-question-types) and [question builder documentation](https://docs.wooclap.com/en/articles/8774298-question-builder) support this distinction between participant interactions and authoring tools.

## Current capabilities for the 14 additional types

**Apply and submit** means implementation is available in suggestion and automatic modes for the inspected controls. **Preview** means the extension can request and show answer data, but the user must apply it on Wooclap. Neither status establishes real-event acceptance.

| Type | Current capability | Constraints and remaining work |
| --- | --- | --- |
| Find a number | Apply and submit | Exact decimal answer validation; native input update and rendered-value verification; prompt includes visible units/range text |
| Open question | Apply and submit | One plain-text contribution per question appearance; no uploads; missing personal experience/preferences require review |
| Word Cloud | Apply and submit | One bounded text contribution; an open/reset form does not authorize another answer |
| Fill in the Blanks | Apply and submit | Complete sentence context; text, inspected custom dropdown, and mixed blanks; menus are opened to read visible options without selecting an answer |
| Matching | Apply and submit | Native dropdown controls; the inspected component clears a prior assignment when its destination is reused, so this adapter sets `uniqueTargets: true` |
| Rating | Apply and submit | One numeric value per proposition; inspected integer scales and keyboard controls; personal preferences must be supplied or reviewed |
| Prioritization | Apply and submit | Nonnegative values satisfying the visible point budget; this is allocation, not a sorting order |
| Brainstorming | Apply and submit | Inspect all menu categories, choose one, verify text, send once, and require a new matching participant-owned answer |
| Framework | Apply and submit | Preserve image/category locations; open the chosen category and verify its new participant-owned contribution |
| Label an image | Apply and submit | Fill every numbered marker; reopen each caption to verify retained controlled state before submitting |
| Find on image | Apply and submit | One point per question; verify marker coordinates and receipt; supported uncropped image geometry only |
| Drag and drop | Apply and submit | Select each numbered item and place it through the inspected image mouse handlers; verify all positions before submitting |
| Script concordance test | Apply and submit | Full case and five custom scale meanings; verify actual score, including zero; preserve optional comments |
| SCT Judgment | Apply and submit | Full scenario and four custom scale meanings; verify hidden-label handle position and selected description |

The model is instructed to avoid inventing personal opinions or experiences. A subjective prompt alone does not provide the participant's preferences. Unrecognized controls stay manual even when the extension is in automatic mode. SCT preparation visits local draft scale positions to expose labels, then restores an existing score or leaves an unsubmitted first-position draft. Required SCT comments remain manual.

## Implemented foundation

- Sorting's media guard now checks rendered images independently of ARIA visibility and rejects meaningful SVG diagrams. Unexpected comment fields are checked before sorting dispatch. Regression cases include media added after a suggestion.
- Answer families, question constraints, field definitions, preview capabilities, and contribution metadata are represented in shared contracts. Protocol 2 is required by the new extension; legacy unversioned requests remain accepted by the new bridge.
- Question fingerprints include full answer context and exclude mutable input values. A separate participant-input snapshot prevents a pending proposal from overwriting later participant edits.
- Text contribution handling prevents a successful response or audience-board update from creating an additional automatic contribution. Uncertain submissions are not retried.
- Family-specific popup previews show proposed values, field mappings, orders, or image coordinates. Recognized image layouts have verified placement paths; popup image overlays remain follow-up work.

Upgrade by rebuilding, restarting the bridge, reloading the extension at `edge://extensions`, and refreshing the participant page. This loads the matching protocol-2 components and preserves the existing pairing token.

## Historical plan: phase 0 repairs

The original prerequisite list was:

1. Fix sorting's media guard. An image marked `aria-hidden` can still be visually meaningful; the current guard skips it. Detect rendered media independently of accessibility visibility and identify meaningful SVGs separately from icons. Until visual sorting is supported, return a review state for these questions.
2. Move the unexpected-comment check ahead of the sorting branch. The latest review reproduced submission despite an added required textarea. Intentional text-answer fields in future adapters must be distinguished from extra comment fields.
3. Add regressions for both findings, including images inserted after an answer is generated. The previous 67-test pass did not cover these cases.
4. Add explicit detection of presentation states so slides, timers, media playback, and result animations consume no requests.
5. Keep the existing MCQ, Poll, sorting, cancellation, screenshot, and uncertain-submission behavior working during the following changes.

Exit condition: the reproduced sorting cases stop before any answer is applied; existing automated tests and the Edge replay pass.

## Current shared contracts and historical design requirements

### Questions and answers

The initial contracts required at least two choices and expressed every answer as `selectedChoiceIds`. The expanded implementation preserves that legacy payload while adding family-specific answer data. `Question.kind` selects the family; optional `wooclapType` preserves the actual participant type.

`Question.fields` describes text, number, or select controls with stable IDs, labels, required state, available options, and bounds. `constraints` includes numeric bounds/step, text limits, allocation total, contribution limit, and optional matching uniqueness. `responseMode` distinguishes one answer from a contribution; `application` distinguishes automatic interaction from preview-only support.

| Answer family | Implemented payload | Validation |
| --- | --- | --- |
| Choice | `selectedChoiceIds` | Available IDs and allowed cardinality. |
| Ordering | `selectedChoiceIds` in requested order | Every item exactly once, in order. |
| Text | `value` string | Visible length limit and nonempty text; one contribution per appearance. |
| Numeric | `value` as a canonical decimal string | Finite numeric value, visible range/step, locale-aware UI formatting; retain precision and units context. |
| Fields | `values: [{ id, value }]` | Exactly one applicable value per required field; select values are that field's option IDs. |
| Matching | `values: [{ id: sourceId, value: targetId }]` | One valid mapping per required source; target reuse only when `uniqueTargets` is not true. |
| Ratings | `values: [{ id, value }]` | Decimal strings satisfying each proposition's bounds and step. |
| Allocation | `values: [{ id, value }]` | Nonnegative decimal strings; exact required total. |
| Categorized entries | `values: [{ id: categoryId, value: text }]` | Existing categories, text limits, bounded unique contributions. |
| Image points | `points: [{ id, x, y }]` | One known point identity; finite coordinates in `[0, 1]` relative to image content. |
| Image placements | `points: [{ id: itemId, x, y }]` | Every label exactly once; finite normalized image coordinates. |
| Scenario scale | `selectedChoiceIds` | Exactly one displayed scale position; comment entry remains unsupported. |

Each bridge answer also carries `selectedChoiceIds` (empty for non-choice families), `explanation`, and `needsReview`. The model receives one strict schema for its family, and the bridge normalizes it into this compatible shape. The bridge and extension both validate against the current question. Numeric range, step, and allocation checks use exact decimal arithmetic. The model returns data, never executable selectors or browser actions.

The bridge advertises protocol 2 in `/health`, accepts unversioned legacy requests and explicit version 2, and rejects other explicit versions. The extension requires protocol 2 before starting. Legacy choice/sorting fingerprints remain unchanged when no new context is present, preserving existing request-ledger keys. New metadata enters fingerprints so changed constraints or fields invalidate cached answers.

### Historical design requirements: adapters and identity

Split the growing adapter into modules by interaction family, with a small registry. Each module owns recognition, extraction, completeness checks, application, rendered-value verification, and receipt detection. Share bounded helpers for controlled text inputs, dropdowns, button selection, and image geometry.

Fingerprints must include all information needed to answer: instructions, scenario sections, blank contexts, field labels, option IDs, scale labels, visible constraints, and image identity. Exclude entered answers, votes, timers, reactions, and movement animations. Sorting retains its deliberate permutation-insensitive identity; other types get explicit rules rather than copying that exception.

Inspect the current public participant component before choosing selectors. The existing downloaded bundle provides starting evidence, not a permanent DOM contract. Never use hidden correct-answer data or private application state to build questions or drive answers.

For controlled inputs, set values through the appropriate native control behavior and dispatch the events verified for that component. Re-read rendered state after each update. Do not assume setting an attribute or dispatching one generic event updates the application.

Track a separate snapshot of participant-entered values while the AI request is pending. Those values stay out of the question fingerprint, but a subsequent participant edit must stop automatic application of the old proposal. The popup can request a fresh review instead of overwriting the participant's work.

### Historical design requirements: submission and repeated contributions

The original lifecycle assumed one selected answer and a separate Submit button. The expansion required explicit metadata for selection versus submission, batch versus per-entry submissions, and whether a successful answer leaves the form open. One-contribution support is implemented; multi-step contribution automation remains future work.

Default to one contribution per question for open-ended activities. An empty input after sending, a new audience answer, or a visible receipt is not evidence of a new question occurrence. Track consumed contributions separately from paid AI requests. If a type requires several intentional submissions, record each step before interacting, confirm it before proceeding, and stop on an uncertain result without replaying earlier steps.

Preserve pause, tab visibility, navigation, closed-question, and stale-answer checks before every action. A receipt must identify the current user's current submission; aggregate counts or another participant's contribution are insufficient.

### Historical design requirements: popup and modes

The original target included editable text, numbers with units context, field/value tables, source/target pairs, numbered orders, allocation totals, and image overlays. Family-specific previews and editable scalar/field suggestions are implemented. Edited values survive popup polling and must pass validation before approval. Model-review answers and preview-only layouts remain read-only. Image overlays remain follow-up work. The model's explanation stays separate from the text submitted to Wooclap.

Each new type starts with local verification and suggestion-mode review. Enable automatic application after its interaction and confirmation path are tested. Feedback prompts may ask for personal opinions that the extension cannot infer: use user-provided preferences or keep the proposed response editable for approval. Factual Word Cloud/Open question prompts can follow the factual-answer flow. Do not label every feedback response as a uniquely correct answer.

## Historical plan: implementation order and per-type work

The original phase order below favored reusable controls before geometry-dependent interactions. It records the intended eventual interaction scope; use the current capability matrix above for what is actually enabled. Complexity is relative effort, not a delivery-time promise.

| Phase | Type / internal name | Planned support and constraints | Complexity |
| --- | --- | --- | --- |
| 1 | **Find a number** / `GuessNumber` | Extract the numeric input, prompt, visible unit/range/step; return a decimal value; set and verify it before submission. Do not read hidden expected values or grading tolerances. | Low–medium |
| 1 | **Open question** / `OpenQuestion` | Start with one plain-text contribution within the actual input limit. Handle controlled input events, Unicode, and uncertain answers. Image uploads and repeated contributions are later capabilities. | Medium |
| 1 | **Word Cloud** / `WordCloud` | Reuse text entry with short responses and the actual character limit. Maintain one-contribution default even when the form permits unlimited answers. Support factual and subjective prompts explicitly. | Medium |
| 2 | **Fill in the Blanks** / `FillInTheBlanks` | Extract the entire sentence with stable blank IDs. Support both text blanks and dropdown blanks, including a mixture in one question. Fill and verify every required field before a single submission. | Medium |
| 2 | **Matching** / `Matching` | Extract each source and its available dropdown destinations. Return source/target ID pairs. Support several sources pointing to the same target; include source images when present. | Medium |
| 3 | **Rating** / `Rating` | Extract every proposition, scale labels, bounds, step, and required state. Show one rating per proposition. Use participant preferences or approval for opinion questions. | Medium |
| 3 | **Prioritization** / `Prioritization` | Allocate points across items; do not reuse the sorting permutation. Check the visible allocation budget and the final total, and preview the distribution. | Medium |
| 3 | **Brainstorming** / `Brainstorm` | Read category IDs and instructions, draft a bounded categorized contribution, and identify its receipt. Changes to the shared board must not create more answers. | Medium–high |
| 3 | **Framework** / `Framework` | Map named or numbered framework regions to response categories; include the background image when it supplies necessary meaning. Reuse categorized entries while preserving the relationship between image labels and fields. | High |
| 4 | **Label an image** / `LabelAnImage` | Capture the image and visible numbered markers together. Return text by marker/field ID. Fill all required captions, with a preview connecting each text answer to its marker. | High |
| 4 | **Find on image** / `ShowOnImage` | Return normalized point coordinates, show a marker preview, map into the current rendered image, and verify the placed marker. Begin with one point; add multiple responses only after per-point submission/receipt behavior is implemented. | High |
| 4 | **Drag and drop** / `DragAndDrop` | Read draggable labels and the visible image. Return item-to-position assignments, then use the component's verified accessible controls or pointer sequence. Verify every placement and determine which action actually submits. | High |
| 5 | **Script concordance test** / `Concordance` | Capture the case, hypothesis, additional information, and exact labeled scale as separate context fields. Return a scale option and short reasoning, with explicit support for a comment field if present. | Medium–high |
| 5 | **SCT Judgment** / `SCTJudgment` | Capture the complete case and behavior to evaluate, then map to the displayed appropriateness scale. Share scale controls with SCT but use a distinct question interpretation. | Medium–high |

### Verified distinctions that affect implementation

- The initial [Matching documentation](https://docs.wooclap.com/en/articles/4341290-matching) review suggested reusable targets. The inspected participant implementation clears an existing assignment when that destination is selected elsewhere. Therefore this adapter sets `uniqueTargets: true`; the shared validator still permits target reuse for future layouts that explicitly support it. Observed controls determine the current interaction constraint.
- Blanks can require typed text or selection from a menu. [Fill in the Blanks documentation](https://docs.wooclap.com/en/articles/4511308-fill-in-the-blanks)
- Numeric questions can expose minimum/maximum limits; grading tolerance is not the same as an input constraint. [Find a number documentation](https://docs.wooclap.com/en/articles/8341086-find-a-number)
- Open question and Word Cloud can permit multiple contributions and can also have graded answers. Their type alone does not determine whether a prompt is subjective. [Open question](https://docs.wooclap.com/en/articles/8336932-open-question), [Word Cloud](https://docs.wooclap.com/en/articles/2824395-word-cloud)
- Rating can contain several propositions. Prioritization currently allocates 100 points; implementation must check participant-visible constraints rather than treating it as ordering. [Rating](https://docs.wooclap.com/en/articles/8317094-rating), [Prioritisation](https://docs.wooclap.com/en/articles/8344712-prioritisation)
- Brainstorming uses response categories. Framework adds an image with labeled response regions, so it may depend on the visual capture work. [Brainstorming](https://docs.wooclap.com/en/articles/3696263-brainstorming), [Framework](https://docs.wooclap.com/en/articles/8312233-framework)
- Label an image requires all captions before submission. Find on image can require a separate submission for each point; clicking another point before submitting replaces the selection. [Label an image](https://docs.wooclap.com/en/articles/5580818-label-an-image), [Find on image](https://docs.wooclap.com/en/articles/3849719-find-on-image)
- Drag and drop places labels onto an image, with editable placements before final submission. The inspected component uses item selection followed by image mousedown/window mouseup to update a draft; a separate submit control sends the answer. [Drag and Drop](https://docs.wooclap.com/en/articles/9991842-drag-and-drop)
- SCT questions compare reasoning with expert-panel responses. The model can propose a reasoned scale choice; it cannot infer an undisclosed panel distribution. [Script concordance test](https://docs.wooclap.com/en/articles/2743688-script-concordance-test), [SCT Judgment](https://docs.wooclap.com/en/articles/4146422-sct-judgment)

### Visual interaction requirements

Use coordinates relative to the actual image content, excluding letterboxing and page margins. Keep CSS pixels, screenshot pixels, device pixel ratio, and browser zoom distinct. Capture the image with its labels; preserve the capture-to-image transform. Re-check geometry immediately before applying an answer and discard a stale placement if the image, layout, or zoom changed.

Test the real interaction library with its transitions and controlled state. A fixture that simply moves a DOM node is insufficient proof of pointer compatibility. If ordinary content-script events cannot drive a particular control reliably, ship its answer preview first and record automatic application as unsupported. Do not add broad browser-debugger permissions by default.

## Validation and release criteria

For each type, record detection, AI-answer generation, UI application, and live receipt verification as separate capabilities.

1. Document the observed participant DOM, relevant visible state, and submit behavior, with source/build date.
2. Add representative local fixtures, including variants and a question that closes or changes during application.
3. Test unknown/duplicate IDs, missing required fields, invalid numeric values, mixed blank types, reused matching targets, and out-of-bounds coordinates as appropriate.
4. Test controlled updates, participant edits, pause/navigation, state changes during image capture, and missing/ambiguous receipts. No unsupported state may result in a click or paid request.
5. Extend the loaded-extension Edge replay, covering at least two consecutive different question types and preserving existing choice/sorting flows.
6. Keep normal tests deterministic and free of paid API calls. `npm run test:types` exercises the expanded Edge fixture flow. `npm run test:openai:types` is a separate optional maximum-three-request paid check for numeric, matching, and image-point schemas; execution results belong in [VERIFICATION.md](VERIFICATION.md). New model-output budgets are bounded by family and field count rather than always using the legacy 800-token cap.
7. When a controlled live event is available, verify actual acceptance separately from local replay and AI accuracy. User-reported MCQ success does not establish support for the new types.

Dynamic contribution types need a specific regression: keep the question open after an accepted contribution and update the audience board repeatedly; the extension must not send another answer. Multi-step types need interrupted-progress tests proving accepted steps are never repeated.

## Implemented files and remaining milestones

The expansion changes these areas:

- `src/shared/types.ts`, `src/shared/core.ts`: versioned question/answer families, validation, type-specific fingerprints.
- `src/content/wooclap.ts`, `src/content/adapter.ts`, `src/content/structured.ts`, `src/content/advanced.ts`, and the `remaining.ts` registry with `contributions.ts`, `image-interactions.ts`, and `scenarios.ts`: shared guards and per-type behavior.
- `src/content/index.ts`, `src/background.ts`: capability dispatch, contribution receipts, progress/ledger handling, cached-contract migration.
- `server/validation.ts`, `server/solver.ts`, bridge health/protocol checks: matching request/response schemas and per-type prompts.
- `src/ui/popup.ts`, popup markup/styles: family-specific previews with automatic approval disabled for preview-only types.
- `tests/fixtures/`, unit/SDK tests, Edge replay scripts, and compatibility documentation: evidence for each capability.

The original first milestone, **sorting repairs + contract foundation + Find a number**, is implemented along with the remaining application paths and previews listed above. Category/caption/geometry interactions, positive local receipts, and complete custom scenario-scale extraction are implemented. Next milestones are controlled live acceptance checks and additional variants (multiple image points, required scenario comments, reusable matching destinations, and unsupported geometry). Local replay and real API responses remain separate evidence from live acceptance.
