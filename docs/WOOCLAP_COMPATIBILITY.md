# Wooclap participant compatibility

## Evidence and scope

Inspected the public application on 2026-09-23. The entrypoint served application build `14.111.0-a7fd9ff45d3f22f4a3b01241fc2c74e1e50731b1` and [this public participant bundle](https://app.wooclap.com/14.111.0-a7fd9ff45d3f22f4a3b01241fc2c74e1e50731b1/bundles/public.min.46c2cc7c1ab9ad812754.js). It establishes the DOM contract below; it is not an official stable automation API. A future Wooclap release can change it.

Re-inspected the public entrypoint on 2026-09-24: build `14.111.2-24bd3cc6cc46d95de0d795ca29b733652a2cfb5f`, [current participant bundle](https://app.wooclap.com/14.111.2-24bd3cc6cc46d95de0d795ca29b733652a2cfb5f/bundles/public.min.f180e886aa3fbbb2ab2a.js). The final contribution, image, and SCT adapters follow these components.

The adapter reads visible page content and interacts with visible controls. It does not access private React state, hidden correct answers, or internal submission endpoints. No account was created and no unrelated live event was joined or answered during development.

## Observed contract

| Feature | Observed public component behavior | Adapter behavior |
| --- | --- | --- |
| Event route | Public event routes use the event slug or alias; aliases are not necessarily six characters | Recognize aliases and supported participant subroutes; reject organizer/login routes |
| Question title | `#question-title[data-test-id="Question.participant.title"]` | Require one visible participant title in a recognized question container |
| Single answer | `ul[aria-labelledby="question-title"][role="radiogroup"]` | Require radio buttons with explicit state |
| Multiple answers | The same list uses `role="group"` | Require checkbox buttons with explicit state |
| Choices | Buttons expose `data-idx`, `role`, `aria-checked`, and `aria-disabled` | Normalize IDs by visible index, preserve order, and verify selection after each click |
| Submit | `[data-test-id="Participant.Submit"]` is a separate control, disabled until a valid local selection | Select first, wait for the rendered state, then submit once |
| Closed voting | Choice controls become disabled `div` elements | Stop answering and wait for the next question |
| Feedback | `[data-test-id="participant-feedback-banner"]` appears under `role="alert"` for several outcomes | Banner presence alone is insufficient confirmation |
| Confirmed vote | Public feedback component uses paper-plane, stars, or circle-xmark icons after a vote | Recognize these positive receipt states regardless of interface language |
| Missed answer | Hourglass feedback indicates that no answer was sent | Never report it as successful submission |
| Choice images | Meaningful images can have empty `alt` and `aria-hidden="true"` | Use rendered visibility for images and include the question region in capture |
| Question identity | The examined question component does not expose its internal question ID on the DOM | Use visible content plus waiting/submission boundaries to track occurrences |

Selection and submission remain deterministic extension code. The model returns validated answer data for the detected family and a separate explanation. Unsupported layouts, additional comments requiring manual input, audio/video/canvas questions, ambiguous controls, and uncertain answers stop for review. Presentation activities are waiting states and consume no AI requests.

## Verification levels

1. **Public source inspection:** confirms the selectors and component behavior used by the adapter.
2. **Synthetic DOM and Edge replay:** `tests/fixtures/wooclap-participant.html`, `structured-participant.html`, `advanced-participant.html`, `contributions-participant.html`, `image-participant.html`, and `scenario-participant.html` recreate observed attributes with original synthetic questions and asynchronous controlled updates. `npm run test:wooclap` and `npm run test:types` fulfill the Wooclap URL locally through Playwright routing. No request reaches Wooclap and no real participant vote is recorded.
3. **Real OpenAI API:** `npm run test:openai` checks at most three synthetic questions. `npm run test:openai:browser` checks at most two through the loaded extension and local replay. The new `npm run test:openai:types` checks at most three new-family responses directly through the solver. These commands can incur API usage; standard tests never invoke them. See [executed results](VERIFICATION.md).
4. **Real event submission:** the user reports live multiple-choice success. Sorting and the new types still require controlled live acceptance checks. Local replay, including replay with a real AI model, does not establish server-side vote acceptance in a real event.

If a question is repeated without an observable waiting/submission boundary and has identical visible content, the extension deliberately avoids another request. Image capture requires opening the extension action on the active event tab and keeping the complete question region visible. An unknown changed layout should be inspected and added as a regression fixture before enabling automatic submission.

## Sorting support (2026-09-23)

Text sorting questions use stable item IDs and a complete ordered answer. The extension clicks visible move-up buttons, waits for each move, verifies the complete order, then submits once. Suggestions display numbered items. Reordering does not trigger another AI request; changed item text or IDs invalidate the answer. Media sorting and unrecognized controls require manual review.

The adapter follows the inspected public participant bundle: .Sorting, data-rbd-droppable-id=sorting, data-rbd-draggable-id, choice-text-<id>, and movement buttons with aria-controls and .fa-arrow-up. Those buttons use a 250 ms lift/move/drop cycle. No internal application state or answer keys are read.

The subsequent review repairs reject meaningful images even when ARIA-hidden, reject meaningful SVG diagrams, and check unexpected comment fields before sorting dispatch. Regression coverage includes media arriving after answer generation. Actual live sorting acceptance remains unverified; current test results are in [VERIFICATION.md](VERIFICATION.md).

## Expanded types (2026-09-24)

The initial expansion used build 14.111.0; the final seven automatic paths were checked against build 14.111.2. Controls below are recognized in the visible DOM, with no private framework-state access.

| Type / component | Observed controls and context | Implemented behavior |
| --- | --- | --- |
| Find a number / `GuessNumber` | One text input with `aria-live="polite"`; visible limit paragraphs | Set through the native setter, verify the decimal, then submit. Values that the component's JavaScript numeric handler would round are rejected. HTML bounds/step are validated when present; paragraph limits remain prompt context. |
| Open question / `OpenQuestion`, `WordCloud` | `textarea#send-message-textarea[data-test-id="TextareaAnswerQuestion"]` | Set/verify one text contribution, submit once, and suppress repeat answers if the form stays open or clears after success. |
| Fill in the Blanks / `FillInTheBlanks` | Text inputs and custom `button[role="combobox"][aria-haspopup="listbox"]` | Preserve sentence context and blank order; open dropdowns to inspect rendered options; fill all fields and recheck options before submission. Mixed typed/dropdown blanks are covered. |
| Matching / `Matching` | `select[name="answer"][aria-labelledby="choice-text-..."]` | Extract each source and destination IDs; exclude the `none` placeholder and dynamic checkmark labels; set/verify all mappings before submission. |
| Rating / `Rating` | One labeled slider per proposition; integer positions and `data-score` rendered after an answer | Use Home/ArrowRight keyboard events, verify both score and ARIA state, then submit. A default minimum alone is not treated as an answer. |
| Prioritization / `Prioritization` | `input[type="number"][id^="choice-"]`, proposition labels, static budget instruction | Ignore the changing points-left counter for identity; require nonnegative integers totaling the visible budget; set/verify values and wait for submit readiness. |
| Brainstorming / `Brainstorm` | Textarea, actual category dropdown options, visible character limit, form paper-plane button | Choose a category, fill/verify one contribution, and require a new matching `answer-*` row with its participant-owned ellipsis menu plus cleared input. Board activity alone is not a receipt. |
| Framework / `Framework` | Background image, `h3[id^="category-"]` labels/pins, `input#framework-answer-input`, form paper-plane button | Include category positions in identity; open a category and verify its field label/text. Send once and require a new matching owned answer in that category. |
| Label an image / `LabelAnImage` | Image with numbered pin buttons and one active native caption input | Open/fill all captions, then reopen each marker to prove retained state before standard submission. Marker geometry is part of question identity. |
| Find on image / `ShowOnImage` | Loaded image inside a button, editable draft pin, separate submit | Map normalized coordinates into CSS pixels, click, verify the pin within 1.5 CSS pixels, submit once, and require positive feedback. An open/reset form cannot create another point. |
| Drag and drop / `DragAndDrop` | Target image and numbered `div`/`h6` labels; selected item plus image mousedown and window mouseup handlers | Select each item, dispatch the inspected mouse sequence, and read back every numbered pin location before one standard submission. No external drag library or debugger permission is needed for this component. |
| SCT / `Concordance`, `SCTJudgment` | Context row and sibling slider, selected-description paragraph, five/four scale positions | Prepare every actual scale description through Home/ArrowRight; retain full case context. Apply and verify the chosen description/score, then submit. Concordance zero uses `data-score` because this build reports -2 in ARIA; Judgment uses handle position plus ARIA because its numeric labels are hidden. |

The inspected Matching handler clears another source when its target is selected again. This adapter therefore sets `uniqueTargets: true`. Official documentation describes reusable targets, so that other layout remains a separate compatibility task; shared contracts already permit reuse when a verified adapter does not require uniqueness.

Automatic families support editable scalar/field suggestions in the popup. Changed question definitions or participant input snapshots block application. Trusted input-intent revisions also protect edits while a controlled component has temporarily restored its previous DOM value. Preview-only families are blocked from application by both the popup and background service, including in automatic mode.

Images must be loaded and fully visible for capture. Image automation uses rendered content bounds and verifies positions after controlled updates. It rejects borders/padding, transformed ancestors, cropped or letterboxed geometry, ambiguous pins, and exact boundary points. Zoom changes while a suggestion is pending invalidate placement. Recognized geometry is tested at 100%, 125%, and 90% zoom; popup image overlays are not implemented. Advanced adapters reject unsupported inline SVG diagrams; supported numbered pin decorations are excluded. Extra fields that are not part of an automatic type's recognized answer controls require manual review.

SCT preparation visits each local draft position to expose its custom description and restores an existing selection. Initially unanswered scales have no public clear control, so preparation leaves the first position as an **unsubmitted draft**, including in suggestion mode. Pause or participant interaction stops further preparation events. Optional comments are preserved; required extra comments use the manual fallback.

Unknown variants retain the prior read-only preview where enough context is available; ambiguous or incomplete content requires review. Brainstorming, Framework, and Find on image default to one contribution per question. Category send controls can show a loading spinner without changing question identity, but clearing the input alone never confirms success.

The updated extension requires bridge protocol 2. Restart the bridge, reload the extension at `edge://extensions`, refresh the participant page, and start a monitoring session. The existing pairing token and local API configuration remain valid.
