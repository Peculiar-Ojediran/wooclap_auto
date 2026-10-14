# Wooclap Auto for Microsoft Edge

An Edge extension that detects a question, requests an answer from NVIDIA DeepSeek, OpenAI, or Claude, and either presents a suggestion or submits it automatically. It observes page changes and runs a five-second backup check. **No bridge token, terminal, Node installation, or local service is required for normal use.**

Includes a bundled practice page and an offline demo solver, plus Wooclap adapters for choices, sorting, and all 14 additional answer types in recognized layouts. The user reports live multiple-choice answering works; live acceptance of sorting and the additional types remains unverified. See [supported types](docs/QUESTION_TYPES_ROADMAP.md), [compatibility evidence](docs/WOOCLAP_COMPATIBILITY.md), and [verification results](docs/VERIFICATION.md).

## Install and use

Use **Microsoft Edge 118 or newer**.

1. Use the built **`dist/edge`** folder, or extract **`dist/edge.zip`** and locate its `edge` folder.
2. Open `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder. Pin Wooclap Auto to the toolbar.
3. Open extension **Settings**. Leave **Automatic / own API key** selected. **NVIDIA (DeepSeek)** is the default. A build connected to the hosted service works without a personal key. Otherwise, choose NVIDIA, OpenAI, or Claude, paste your own key, and choose **Save API key**.
4. Choose **Save & check connection**. This checks your saved key or shared-service readiness without an AI request. The first answer checks actual provider access. Shared fallback always uses `deepseek-ai/deepseek-v4.1-flash`; the Model field applies when using your own key.
5. Open a Wooclap participant question, open the popup, and choose **Start on this tab**. Start with **Suggest answers** to review before submitting.

On upgrade, choose **Reload** at `edge://extensions`, accept the API-host permission changes if prompted, and refresh participant/practice pages. Direct API becomes the default for older settings too. Previously remembered keys remain available; session-only keys must be entered again after an extension reload. Keys stored only in a bridge `.env` are not imported into the extension.

## Shared NVIDIA fallback

When the selected provider has no saved key, automatic mode uses the hosted NVIDIA service. Personal keys take priority and go directly to the selected provider. Invalid, expired, rate-limited, or rejected personal keys do **not** trigger another request through the fallback. Local bridge and demo modes remain explicit choices.

**The repository includes the service but no live deployment URL.** The packaged build therefore reports shared fallback as unavailable until the operator deploys it and rebuilds with `HOSTED_FALLBACK_URL`. Personal-key mode and offline practice work now. See [deployment steps](docs/HOSTED_FALLBACK.md) and [implementation plan](docs/NVIDIA_FALLBACK_PLAN.md).

The shared key stays in Cloudflare Workers secret storage. The extension sends question content and included screenshots to the shared service, then NVIDIA; it sends no personal API keys or cookies. Event URLs, question IDs, and image source URLs are removed from the hosted request. The service fixes the model and enforces persistent global and per-network request budgets. Shared builds have a stable public extension identity for distribution; switching from a prior unpacked install may require loading it as a new extension and re-entering settings/keys.

## Try the offline demo without an API key

Select **Local practice demo** in Settings and save. Choose **Open practice page**, then start from the popup on that page. Approve a suggestion, try another question, or switch to **Submit automatically**. The practice page is packaged inside the extension and works without a server or internet connection.

Demo answers are fixed answers for the bundled questions and never call a provider. Demo mode refuses live Wooclap questions. To try real AI on the practice page, switch back to Automatic / own API key and use a configured shared service or save a provider key.

## API keys and models

Keys default to **this browser session only**. To retain one after Edge exits, select **Remember this key on this device** and approve the permission prompt. Declining saves nothing. No cookies are used.

Session keys survive service-worker suspension but clear when the browser session ends or the extension is reloaded, disabled, or updated. Remembered keys use local extension storage without encryption by the extension. **Forget key** removes both extension copies for the selected provider. Saving a replacement with Remember unchecked removes any remembered copy. Changing keys pauses answering and discards cached suggestions.

Keys are accessible to trusted extension pages and the background worker, never Wooclap pages or content scripts. Direct requests go from the worker to the selected provider's fixed HTTPS endpoint, with cookies omitted. Keys are never bundled, returned in status messages, added to prompts, or logged. Direct mode uses browser-held credentials; OpenAI's [API authentication guidance](https://developers.openai.com/api/reference/overview) recommends server-side secret handling. The optional bridge remains available.

NVIDIA defaults to [`deepseek-ai/deepseek-v4.1-flash`](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash), with text and image input. Its documented API uses Chat Completions; JSON is requested in the prompt and strictly validated locally, because its request schema does not advertise `response_format`. OpenAI defaults to `gpt-4.1-mini`; Claude defaults to `claude-sonnet-5-5`. The editable Model setting determines the request model. Choose one available to your account with image input; the OpenAI and Claude adapters require structured-output support. See [Anthropic model identifiers](https://platform.claude.com/docs/en/models/overview). **API requests may incur provider usage charges.** See [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Direct mode allows one active request and at most 30 starts per minute, preserved across worker restarts. The per-page request limit also survives pause/resume. Errors never trigger automatic retries or demo substitution. [Standalone design and checks](docs/STANDALONE_PLAN.md).

## Answer while using other tabs or minimizing Edge

1. Enable **Keep answering in the background** in Settings and save. Select **Submit automatically** if you want submission without approval.
2. Start on the Wooclap tab, then switch tabs or minimize Edge. Suggestion mode continues preparing answers and waits for approval in the popup.

Background mode captures only the monitored tab. Keep its full question within the viewport before leaving it. Edge displays a debugging banner while connected; close DevTools for that tab. **Pause** releases the connection and restores its prior automatic-discard setting.

Background mode defaults off; with it off, switching away pauses answering. Keep Edge running and an internet connection for provider requests. This cannot run while Edge is closed or the computer sleeps. Navigation, lost capture, closed questions, and uncertain submissions retain their existing safeguards. [Background design](docs/BACKGROUND_MODE_PLAN.md).

## Optional local bridge

For development or server-side environment keys, use Node.js 24 or newer, run `npm install`, and select **Local bridge** in Settings. Run `npm start` for API answers or `npm run demo` for the old localhost practice/demo flow. Enter the pairing token from `.local/bridge-token.txt`, then **Save & check connection**. Bridge mode still requires its running service and protocol 2; direct mode does not contact localhost.

Optionally copy `.env.example` to `.env` if that file does not already exist, and set `NVIDIA_API_KEY`, `OPENAI_API_KEY`, and/or `ANTHROPIC_API_KEY`. `OPENAI_MODEL` and `ANTHROPIC_MODEL` report bridge defaults; extension Model selects the request model. A key entered in extension Settings overrides the selected provider's environment key for that request. Forgetting an extension key leaves separate environment configuration unchanged.

The bridge listens at `http://127.0.0.1:4318`. It creates its pairing token on first use unless `BRIDGE_TOKEN` is configured (at least 32 characters). `.env` and `.local` are ignored by Git. Bridge API access requires the pairing token and rejects website origins. Earlier provider/key implementation details are in [the provider plan](docs/PROVIDERS_AND_KEYS_PLAN.md).

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
| Brainstorming | Choose a category and send one contribution | Verify a new participant-owned receipt; audience activity never triggers another answer |
| Framework | Open an image category and send one contribution | Preserve image/category mapping and verify a participant-owned receipt |
| Label an image | Fill every caption, reopen each marker to verify, then submit | Requires recognized numbered pins and retained editable captions |
| Find on image | Place and verify one normalized image point, then submit | One point per question; image must be loaded with supported geometry |
| Drag and drop | Place every numbered label, verify positions, then submit | Uses the inspected image mouse controls; changed image geometry stops application |
| Script concordance test / SCT Judgment | Read complete custom scale labels, select and verify a position, then submit | Preserve optional comments; required extra comments remain manual |

SCT preparation selects each local scale position to read its description, then restores an existing selection. If initially unanswered, it leaves the first position as an **unsubmitted draft**, including in suggestion mode. Image automation rejects cropped/letterboxed images, transformed containers, and unsupported controls; exact image-edge coordinates require manual placement. See the [remaining-types plan](docs/REMAINING_TYPES_PLAN.md) for the implementation and limits.

Presentation activities (Audio / Video, Slide, Timer, Spin the wheel) are waiting states and do not trigger an AI request. **Create using AI** is an organizer tool; the generated participant question is handled by its actual type.

- The adapters recognize participant event aliases, closed voting, meaningful images, and positive submission feedback. Their observed contracts are documented in [compatibility evidence](docs/WOOCLAP_COMPATIBILITY.md). A separate generic adapter supports the local practice page.
- **Advanced page selectors** can specify the visible question, choice controls, submit button, and submission confirmation. Leave them empty for the practice page. Configure them after inspecting a real layout, and test in suggestion mode first. The immediate-submit option is only for single-choice layouts where clicking a choice submits it.
- Images trigger a cropped capture of the question region when image capture is enabled. The complete question must fit its tab viewport. Background mode captures that tab directly while you use another tab or minimize Edge; foreground mode requires keeping it visible. The five-second backup check is best effort and cannot run while the computer sleeps.
- Each session binds to one tab and event. Changed or closed questions invalidate pending answers. Participant edits while an answer is pending stop its automatic application. Before submitting, the extension rechecks question identity and current controls, attempts submission once, and looks for confirmation; uncertain results require review. Open-ended activities remain limited to one contribution per question appearance even if the form stays open.
- Pausing preserves a completed suggestion so it can be restored without another request. Cached answers are specific to the provider and selected model. An interrupted AI request is not automatically retried for the same question occurrence; it may already have incurred usage. The next question can proceed normally.
- Provider clients distinguish invalid credentials, quota/rate limits, unsupported models, timeouts, refused/incomplete answers, and invalid answer payloads. Shared answer schemas validate responses in direct and bridge modes. Errors never trigger an automatic retry or demo fallback. Review answers retain their explanation but cannot be submitted automatically.
- An AI answer can be wrong even when it passes validation. The small synthetic API test set does not establish general accuracy. The observed Wooclap DOM can change. User-reported live MCQ success does not establish live acceptance for sorting or the new types.

Question text, choices, field definitions, visible constraints, and any required cropped screenshot are sent to the selected provider in API mode, via the shared service when fallback is active. The application does not save screenshots to disk. Activity messages exclude API keys and screenshot contents. The local service requires the pairing token and rejects browser page origins for its API routes.

## Development

Building from source requires Node.js 24 or newer. Run `npm install` and `npm run check` to install dependencies, validate, and build. Reload the unpacked extension after rebuilding.

```powershell
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:images
npm run test:wooclap
npm run test:types
npm run test:background
npm run test:credentials
npm run test:standalone
```

Stop any demo/API service before running browser tests. The existing bridge replays start an isolated test bridge on port `4318`; `test:standalone` instead requires no listener and runs Edge offline with injected provider responses. It verifies packaged practice, direct requests, refusals, cancellation, and background/minimized visual answering. The browser smoke test tries Microsoft Edge first, then bundled Chromium; install it with `npx playwright install chromium` if needed. Screenshot and standalone checks require installed Microsoft Edge. Tests use temporary browser profiles, leaving your normal Edge profile untouched.

`test:types` exercises the new question families through the loaded Edge extension and local participant fixtures. Standard tests use deterministic solvers or injected SDK transports and make no paid API calls. Coverage includes asynchronous controls, screenshots, decimal precision, complete field answers, matching constraints, repeated contributions, participant edits, cancellation, category receipts, caption retention, image geometry/zoom, custom scenario scales, and preview fallbacks. See [verification results](docs/VERIFICATION.md) for the latest executed checks and counts.

Explicit paid verification commands (never run by `npm test` or `npm run check`):

```powershell
npm run test:openai
npm run test:openai:browser
npm run test:openai:types
```

`test:openai` makes at most three real requests; `test:openai:browser` makes at most two through the Edge extension and a network-isolated Wooclap layout replay. Those earlier checks passed using `gpt-4.1-mini`. `test:openai:types` is a separate, explicit **maximum-three-request** check for numeric, matching, and image-point schemas; all three passed on 2026-09-24. It requires installed Edge to render the synthetic image. See [verification results](docs/VERIFICATION.md) for usage and scope. These tests do not submit to a real Wooclap event. Sanitized reports and screenshots are saved under `test-results/`.

| Path | Purpose |
| --- | --- |
| `PLAN.md` | Implementation plan and acceptance checks |
| `extension/` | Manifest, popup/settings markup, and styles |
| `src/background.ts`, `src/background-tab.ts` | Session coordination, optional background operation, and tab-specific capture |
| `src/content/` | Question extraction, change detection, and page interaction |
| `src/ui/` and `src/shared/` | Popup/settings behavior and shared contracts |
| `src/ai/` | Browser-compatible provider/demo solvers and answer schemas |
| `server/` | Optional local bridge, shared solver reexports, and practice source |
| `tests/` and `scripts/` | Automated checks and build/browser tooling |
| `dist/edge/` | Generated extension folder to load into Edge |

For direct API errors, check the saved provider key, selected model, API access, and internet connection. In optional bridge mode, also check the running service, port `4318`, and pairing token. For an unsupported real question, pause and inspect its controls before configuring selectors. The next live validation step is checking extraction and confirmed vote acceptance in a controlled test event.

## Sorting support and review repairs

Text sorting questions use stable item IDs and a complete ordered answer. The extension clicks visible move-up buttons, waits for each move, verifies the complete order, then submits once. Suggestions display numbered items. Reordering does not trigger another AI request; changed item text or IDs invalidate the answer. Media sorting and unrecognized controls require manual review.

The adapter follows the inspected public participant bundle: .Sorting, data-rbd-droppable-id=sorting, data-rbd-draggable-id, choice-text-<id>, and movement buttons with aria-controls and .fa-arrow-up. Those buttons use a 250 ms lift/move/drop cycle. No internal application state or answer keys are read.

The later review findings are repaired: rendered images are checked even when `aria-hidden`, meaningful SVG diagrams stop sorting, and unexpected comment fields are checked before the sorting branch. Regression coverage includes media introduced after a suggestion. Actual live sorting acceptance remains unverified; current test results are recorded in [verification results](docs/VERIFICATION.md).
