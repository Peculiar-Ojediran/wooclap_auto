# Wooclap participant compatibility

## Evidence and scope

Inspected the public application on 2026-09-23. The entrypoint served application build `14.111.0-a7fd9ff45d3f22f4a3b01241fc2c74e1e50731b1` and [this public participant bundle](https://app.wooclap.com/14.111.0-a7fd9ff45d3f22f4a3b01241fc2c74e1e50731b1/bundles/public.min.46c2cc7c1ab9ad812754.js). It establishes the DOM contract below; it is not an official stable automation API. A future Wooclap release can change it.

The adapter reads visible page content and interacts with visible controls. It does not access private React state, hidden correct answers, or internal submission endpoints. No account was created and no unrelated live event was joined or answered during development.

## Observed contract

| Feature | Observed public component behavior | Adapter behavior |
| --- | --- | --- |
| Event route | Public event routes use the event slug or alias; aliases are not necessarily six characters | Recognize aliases and supported participant subroutes; reject organizer/login routes |
| Question title | `#question-title[data-test-id="Question.participant.title"]` | Require one visible participant title in an MCQ/Poll container |
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

Selection and submission remain deterministic extension code. The model returns only existing choice IDs and a short explanation. Unsupported layouts, comments requiring manual input, audio/video/canvas questions, ambiguous choices, and uncertain answers stop for review.

## Verification levels

1. **Public source inspection:** confirms the selectors and component behavior used by the adapter.
2. **Synthetic DOM and Edge replay:** `tests/fixtures/wooclap-participant.html` recreates those observed attributes with original synthetic questions and asynchronous selection updates. `npm run test:wooclap` fulfills the Wooclap URL locally through Playwright routing. No request reaches Wooclap and no real participant vote is recorded.
3. **Real OpenAI API:** `npm run test:openai` checks at most three synthetic questions. `npm run test:openai:browser` checks at most two questions through the loaded Edge extension, local bridge, actual OpenAI API, and the synthetic participant layout. These commands can incur API usage; standard tests never invoke them.
4. **Real event submission:** still requires a controlled live participant event. Local replay, including replay with a real AI model, does not establish server-side vote acceptance in a real event.

If a question is repeated without an observable waiting/submission boundary and has identical visible content, the extension deliberately avoids another request. Image capture requires opening the extension action on the active event tab and keeping the complete question region visible. An unknown changed layout should be inspected and added as a regression fixture before enabling automatic submission.

## Sorting support (2026-09-23)

Text sorting questions use stable item IDs and a complete ordered answer. The extension clicks visible move-up buttons, waits for each move, verifies the complete order, then submits once. Suggestions display numbered items. Reordering does not trigger another AI request; changed item text or IDs invalidate the answer. Media sorting and unrecognized controls require manual review.

The adapter follows the inspected public participant bundle: .Sorting, data-rbd-droppable-id=sorting, data-rbd-draggable-id, choice-text-<id>, and movement buttons with aria-controls and .fa-arrow-up. Those buttons use a 250 ms lift/move/drop cycle. No internal application state or answer keys are read.

Validation: 67 automated tests pass, including ordered-answer SDK serialization, malformed permutations, asynchronous moves, cancellation, changed questions, and order changes before submission. The Edge replay covers sorting with a synthetic solver. No paid API calls were made for this update. Actual live sorting acceptance remains unverified. Reload the extension at edge://extensions and refresh the participant page after updating. Restart the bridge to load the sorting prompt and validation.
