# Wooclap Auto for Microsoft Edge

An unpacked Edge extension that detects a question, requests an AI answer through a local service, and either presents a suggestion or submits the answer automatically. It observes page changes and runs a five-second backup check.

Includes a **local practice page and a demo solver that needs no API key**, plus Wooclap participant adapters for choices, text sorting, seven additional types with automatic application, and seven types with answer previews. The user reports that live multiple-choice answering works. Sorting and the new types have separate local verification; their live event acceptance is unverified. See [the support roadmap](docs/QUESTION_TYPES_ROADMAP.md), [compatibility evidence](docs/WOOCLAP_COMPATIBILITY.md), and [verification results](docs/VERIFICATION.md).

## Try the local version

Use Microsoft Edge and **Node.js 24 or newer**. Open PowerShell in this project folder.

1. Install dependencies, check the project, and build the extension:

   ```powershell
   npm install
   npm run check
   ```

   `check` runs TypeScript checks, automated tests, and the extension build. To rebuild after editing the source, run `npm run build`.

2. Start the demo service and leave this terminal running:

   ```powershell
   npm run demo
   ```

   The service listens at `http://127.0.0.1:4318`. On its first run, it generates a pairing token in `.local/bridge-token.txt`. The console prints the file location, never the token itself.

3. In Edge, open `edge://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this project's **`dist/edge`** folder. Pin **Wooclap Auto** to the toolbar if desired.

4. Open the extension popup, then its **settings** button. Copy the contents of `.local/bridge-token.txt` into the **Bridge pairing token** field and choose **Save & check connection**. The connection should report that demo answers are enabled. Leave **Suggest answers** selected for the first run.

   To copy the generated token without printing it in the terminal:

   ```powershell
   Get-Content .local/bridge-token.txt | Set-Clipboard
   ```

5. Open `http://127.0.0.1:4318/practice` in Edge, or use **Open practice page** in the popup. Open the popup on that tab and choose **Start on this tab**. When a suggestion appears, choose **Approve & submit**. The page should show submission confirmation.

6. Use the practice page's question controls to try another question, repeat a question, or show a waiting screen. To test automation, **Pause**, change the settings to **Submit automatically**, save, return to the practice tab, and start again. Choose a new question to see it answered automatically.

Demo answers are fixed answers for the bundled practice questions. They exercise detection, answer selection, and submission without testing AI accuracy. Demo mode refuses live Wooclap questions.

After rebuilding, choose **Reload** for the extension at `edge://extensions` and refresh the practice or participant page. A reloaded extension requires you to start the session again.

**Upgrading to the expanded question types:** stop the previous bridge with **Ctrl+C**, run `npm run build`, restart it with `npm start` (or `npm run demo`), reload the extension, then refresh the participant page. The new extension requires **bridge protocol 2** and reports a version mismatch if an old bridge is still running. The bridge continues accepting legacy requests without an explicit protocol version; existing pairing tokens and API configuration remain usable.

## Use the OpenAI API

Create a local environment file if you do not already have one:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env` and set `OPENAI_API_KEY` to your API key. The default model is `gpt-4.1-mini`; the extension's **Model** setting selects the model sent with each request. The local service also accepts `OPENAI_MODEL` as its reported default. A selected model must support image inputs and structured outputs for all features to work.

Stop the demo service with **Ctrl+C**, then run:

```powershell
npm start
```

Use **Save & check connection** again. This checks the local service and whether a key is configured; the next answer verifies actual OpenAI access. The popup identifies the session source and shows the latest response's model, elapsed time, and reported token usage. You can test real AI answers on the local practice page before trying a Wooclap event. Join an event manually, open its participant question, and choose **Start on this tab**.

For Wooclap, leave the advanced selectors empty initially. The adapters recognize supported participant controls, wait for their rendered updates, and use the separate submit button. Keep **Clicking a choice immediately submits the answer** disabled for Wooclap multiple-choice questions. Begin with suggestion mode while checking a new live layout. Types marked **Preview** below display answer data for manual application, including when automatic mode is selected.

The API key stays in `.env` on your computer; do not put it in the extension. The extension stores a separate pairing token in local browser settings. If you set `BRIDGE_TOKEN` in `.env`, use that value in the extension instead of the generated file; it must be at least 32 characters long. `.env`, `.local`, and generated build output are ignored by Git.

**Real API requests can incur OpenAI usage charges.** Demo mode makes no AI requests. The extension has a request limit for each loaded participant page, preserved across pause/resume and reset when a new page is loaded. The service accepts at most 30 solve requests per minute with one active solve at a time. API failures are shown as errors and never replaced with demo answers. The [OpenAI pricing page](https://developers.openai.com/api/docs/pricing) lists current rates.

## Supported behavior and current limits

| Type | Available behavior | Current limits |
| --- | --- | --- |
| Multiple choice / true-false / Poll | Suggest or apply and submit | Explicit single/multiple controls; personal preferences require review |
| Sorting | Suggest the complete order, move items, verify, and submit | Text items only; meaningful media and extra comment fields stop the flow |
| Find a number | Enter a decimal, verify its value, and submit | Preserve numeric precision; visible range/step and units context |
| Open question / Word Cloud | Enter and submit one text contribution | No uploads or repeated contributions; personal experiences/preferences are not invented |
| Fill in the Blanks | Fill and verify all text or dropdown blanks, then submit | Supports the inspected custom dropdown and mixed text/dropdown layout |
| Matching | Set and verify each source dropdown, then submit | Current observed controls require unique destinations; duplicate assignments are rejected |
| Rating | Set and verify each proposition's displayed scale, then submit | Inspected integer scales; missing personal preferences require review |
| Prioritization | Enter and verify allocations, then submit | Nonnegative points must total the visible budget |
| Brainstorming | Preview one contribution | Uses the currently selected category; apply and submit manually |
| Framework | Preview a contribution associated with an image category | Requires the framework image and visible category labels; manual application |
| Label an image | Preview one caption per visible numbered marker | Manual application |
| Find on image | Preview one normalized image point | Manual placement and submission |
| Drag and drop | Preview label-to-position assignments | Manual placement and submission |
| Script concordance test / SCT Judgment | Preview a scale proposal with case context | Custom scale meanings may be unavailable; ambiguous interpretation requires review; manual application |

Presentation activities (Audio / Video, Slide, Timer, Spin the wheel) are waiting states and do not trigger an AI request. **Create using AI** is an organizer tool; the generated participant question is handled by its actual type.

- The adapters recognize participant event aliases, closed voting, meaningful images, and positive submission feedback. Their observed contracts are documented in [compatibility evidence](docs/WOOCLAP_COMPATIBILITY.md). A separate generic adapter supports the local practice page.
- **Advanced page selectors** can specify the visible question, choice controls, submit button, and submission confirmation. Leave them empty for the practice page. Configure them after inspecting a real layout, and test in suggestion mode first. The immediate-submit option is only for single-choice layouts where clicking a choice submits it.
- Images trigger a cropped capture of the visible question region when image capture is enabled. Keep the monitored tab active and the entire question and its choices visible. Switching tabs or hiding needed content prevents capture/submission. Browser background throttling means the five-second backup check has no exact timing guarantee in inactive tabs or sleeping windows.
- Each session binds to one tab and event. Changed or closed questions invalidate pending answers. Participant edits while an answer is pending stop its automatic application. Before submitting, the extension rechecks question identity and current controls, attempts submission once, and looks for confirmation; uncertain results require review. Open-ended activities remain limited to one contribution per question appearance even if the form stays open.
- Pausing preserves a completed suggestion so it can be restored without another request. Cached answers are specific to the provider and selected model. An interrupted AI request is not automatically retried for the same question occurrence; it may already have incurred usage. The next question can proceed normally.
- The service distinguishes invalid credentials, quota/rate limits, unsupported models, timeouts, refused/incomplete answers, and invalid answer payloads. It validates the appropriate answer family on both sides of the bridge. Errors never trigger an automatic retry or demo fallback. Review answers retain their explanation but cannot be submitted automatically.
- An AI answer can be wrong even when it passes validation. The small synthetic API test set does not establish general accuracy. The observed Wooclap DOM can change. User-reported live MCQ success does not establish live acceptance for sorting or the new types.

Question text, choices, field definitions, visible constraints, and any required cropped screenshot are sent to OpenAI only in API mode. The application does not save screenshots to disk. Activity messages exclude API keys and screenshot contents. The local service requires the pairing token and rejects browser page origins for its API routes.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:images
npm run test:wooclap
npm run test:types
```

Stop the demo/API service before running browser tests: they start an isolated test bridge on port `4318`. The browser smoke test exercises the loaded extension with the local practice page. It tries Microsoft Edge first, then bundled Chromium. If Chromium is missing, install it with `npx playwright install chromium`. The image test specifically requires installed Microsoft Edge and exercises its toolbar action to grant screenshot access. Tests use temporary browser profiles, leaving your normal Edge profile untouched.

`test:types` exercises the new question families through the loaded Edge extension and local participant fixtures. Standard tests use deterministic solvers or injected SDK transports and make no paid API calls. Coverage includes asynchronous controls, screenshots, decimal precision, complete field answers, matching constraints, repeated contributions, participant edits, cancellation, and preview-only types. See [verification results](docs/VERIFICATION.md) for the latest executed checks and counts.

Explicit paid verification commands (never run by `npm test` or `npm run check`):

```powershell
npm run test:openai
npm run test:openai:browser
npm run test:openai:types
```

`test:openai` makes at most three real requests; `test:openai:browser` makes at most two through the Edge extension and a network-isolated Wooclap layout replay. Those earlier checks passed using `gpt-4.1-mini`. `test:openai:types` is a separate, explicit **maximum-three-request** check for numeric, matching, and image-point schemas; it requires installed Edge to render the synthetic image. Adding this command is not evidence that it passed: consult [verification results](docs/VERIFICATION.md) for its execution status. These tests do not submit to a real Wooclap event. Sanitized reports and screenshots are saved under `test-results/`.

| Path | Purpose |
| --- | --- |
| `PLAN.md` | Implementation plan and acceptance checks |
| `extension/` | Manifest, popup/settings markup, and styles |
| `src/background.ts` | Session state, local-service requests, and submission coordination |
| `src/content/` | Question extraction, change detection, and page interaction |
| `src/ui/` and `src/shared/` | Popup/settings behavior and shared contracts |
| `server/` | Local bridge, AI/demo solvers, and practice page |
| `tests/` and `scripts/` | Automated checks and build/browser tooling |
| `dist/edge/` | Generated extension folder to load into Edge |

If connection checks fail, confirm that the service is running, port `4318` is available, and the settings token matches the active service. For an unsupported real question, pause the session and inspect its controls before configuring selectors. The next live validation step is checking extraction and confirmed vote acceptance in a controlled test event.

## Sorting support and review repairs

Text sorting questions use stable item IDs and a complete ordered answer. The extension clicks visible move-up buttons, waits for each move, verifies the complete order, then submits once. Suggestions display numbered items. Reordering does not trigger another AI request; changed item text or IDs invalidate the answer. Media sorting and unrecognized controls require manual review.

The adapter follows the inspected public participant bundle: .Sorting, data-rbd-droppable-id=sorting, data-rbd-draggable-id, choice-text-<id>, and movement buttons with aria-controls and .fa-arrow-up. Those buttons use a 250 ms lift/move/drop cycle. No internal application state or answer keys are read.

The later review findings are repaired: rendered images are checked even when `aria-hidden`, meaningful SVG diagrams stop sorting, and unexpected comment fields are checked before the sorting branch. Regression coverage includes media introduced after a suggestion. Actual live sorting acceptance remains unverified; current test results are recorded in [verification results](docs/VERIFICATION.md).
