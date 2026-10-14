# Remaining automatic question types

Implementation plan: 2026-09-24. This extends the seven existing previews into guarded application paths. Public participant controls are the source of truth; live event acceptance remains a separate check.

| Type | Read and prepare | Apply and verify | Submission receipt |
| --- | --- | --- | --- |
| Brainstorming | Read the actual contribution-category menu and visible text limit; exclude board filters and audience posts from identity. | Select one category, enter one contribution, verify both. | Use the contribution form's send button and require a new matching participant-owned answer plus cleared input. |
| Framework | Read image/category relationships and numbered pins. | Open the chosen category, fill the visible answer field, and verify text/category. | Use the form send control and verify the newly added participant-owned contribution. |
| Label an image | Read all numbered markers and the target image. | Open each caption input, set its value, and reopen every marker to verify retained values. | Submit the complete set once and require standard positive feedback. |
| Find on image | Read one loaded target image and its rendered content bounds. | Convert one normalized answer point to browser coordinates; click the image and verify the visible draft marker. | Submit once and require positive feedback; do not create repeated points while the form remains open. |
| Drag and drop | Read numbered labels, target image, and existing draft placements. | Use the inspected component's item-selection and image mouse handlers; verify every visible placement. | Submit the complete placement set once and require positive feedback. |
| Script concordance test | Read the full case, hypothesis, additional information, and every scale description. | Select the model's exact scale position using public keyboard controls; verify the rendered score and description. | Submit once and require positive feedback. Preserve optional participant comments. |
| SCT Judgment | Read scenario/behavior and all four custom scale descriptions. | Use its four-position scale, accounting for hidden numeric labels; verify position and selected description. | Submit once and require positive feedback. Preserve optional participant comments. |

## Shared implementation

1. Inspect the current public bundle and record each control/event/receipt contract. Keep existing fixtures as regression evidence, adding realistic fixtures for the newly supported layouts.
2. Add separate contribution, image-interaction, and scenario modules. Route extraction, input snapshots, application, verification, and custom submission through those modules before older preview fallbacks.
3. Run bounded preparation before publishing a question to the bridge. Category menus expose their options without submitting. SCT descriptions appear only after selecting each local scale position: inspect the draft positions without submitting, restore an existing selection when present, and retain an unsubmitted draft when the public controls cannot restore an unanswered state. Cancel preparation on human interaction, pause, navigation, or question replacement.
4. Keep changing drafts and audience activity out of question identity. Include full scale meanings, label/category mapping, and image identity. Include image geometry and current draft values in the pending-answer snapshot so a resize or participant edit invalidates application.
5. Keep one contribution/point per question by default. Record submission attempts before clicking, distinguish own receipts from board activity, and never retry an uncertain send. Verify each editable value or image position before the final submit.
6. Preserve the strict existing answer schemas. Add no model-generated browser actions, private application access, or browser-debugger permission. Optional comments stay untouched; unsupported required extra controls stop application.

## Acceptance checks

- Unit tests for all seven types: malformed mappings, stale content/geometry, async controlled updates, interrupted preparation/application, closed controls, edited values, and missing or unrelated receipts.
- Actual Edge extension replay for all seven application paths, including images at non-default zoom/size where supported, consecutive different types, contribution deduplication, and cancellation.
- Regression checks for existing choices, sorting, numeric/text/field answers, image capture, and bridge contracts.
- Ordinary tests use deterministic responses. The answer schemas already have real API coverage; additional paid checks are needed only if that contract changes.
- Update the support matrix with tested variants and precise remaining limitations. Rebuild the unpacked extension and restart the bridge if server code changes.

## Implementation result

All seven recognized layouts now have automatic application paths in `src/content/contributions.ts`, `image-interactions.ts`, and `scenarios.ts`, dispatched through `remaining.ts`. Extraction, pending input snapshots, verified application, and receipts are integrated with the existing session and request ledger. The existing OpenAI answer schemas and bridge protocol 2 are preserved.

The public participant entrypoint was rechecked against build **14.111.2** on 2026-09-24. [Compatibility evidence](WOOCLAP_COMPATIBILITY.md) records the inspected controls and limits. [Verification results](VERIFICATION.md) record 173 passing tests, the extension build, existing Edge regressions, and the expanded 18-case Edge replay with five lifecycle checks. Ordinary verification makes no paid API calls.

Additional variants remain separate work: multiple image points per question, required SCT comment generation, image overlays, reusable matching destinations, and unsupported image geometry. Unknown layouts use a read-only preview where context is sufficient, otherwise a review state. Actual live acceptance of these seven types remains unverified.
