# Standalone Edge extension

## User workflow

Install or reload `dist/edge`, open Settings, choose Direct API and a provider, and save an API key. Start on a Wooclap question. No pairing token, Node installation, terminal, or local service is required for everyday use. Building from source still uses Node/npm.

Keys remain session-only unless the user explicitly consents to remembering them. Keep the existing Forget action and trusted-context storage boundaries. Calls use the user's own key; no shared key is embedded in the package.

## Architecture

1. Make `connectionMode: direct` the default, including upgrades. Preserve the optional local bridge configuration for development and users who explicitly select it.
2. Move provider solvers and strict answer contracts into browser-compatible shared modules. Reexport them from the existing server paths so bridge tests and tools still work.
3. Send provider requests only from the background worker to fixed HTTPS endpoints. Require explicit browser SDK support, omit cookies/referrers, reject redirects, preserve structured outputs, image validation, full-body deadlines, cancellation, no retries, and sanitized errors.
4. Add provider host permissions and CSP destinations. Check selected-key configuration locally without issuing a paid probe. Authentication is checked by the first answer request.
5. Preserve per-page limits and consumed request claims. Add a worker-level single-request gate and a 30-per-minute history in session storage; distinguish direct/bridge/demo caches and response attribution.
6. Package the practice fixture as `practice.html` and external `practice.js`, with the existing content adapter. Recognize only this extension's own exact practice URL; only Settings and popup pages may invoke administrative commands.
7. Provide Local practice demo mode, which returns known fixture answers without network calls. Keep foreground behavior and opt-in background/minimized capture.

## Verification

- Existing bridge, provider, adapter, cancellation, key-storage, and UI tests continue passing.
- Browser-built solvers run without Node globals; requests use fixed endpoints and strict schemas, keep keys out of prompts, and reject unsafe outputs.
- Direct request gate tests cover concurrency, rate limits, and service-worker recreation.
- Standalone Edge replay runs offline with no localhost listener. Injected provider transports verify real serialized requests for both providers, API-key isolation, demo submission, refusals, invalid answers, cancellation, cache isolation, and background operation.
- Existing Edge practice, screenshot, Wooclap layout, expanded types, background, and credential tests retain explicit bridge-mode coverage.
- Rebuild the extension and ZIP and compare archive contents to the build. Tests use synthetic keys and do not make paid provider calls.

## API sources and limits

- [Extension network permissions and CSP](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [OpenAI authentication and credential guidance](https://developers.openai.com/api/reference/overview)
- [Anthropic browser SDK opt-in](https://github.com/anthropics/anthropic-sdk-typescript)

Direct mode places the user's credentials in the browser extension; provider documentation generally recommends server-side secret handling. Keys are never shipped in source, returned to Wooclap content scripts, or logged. Remembered keys use local extension storage without encryption by the extension. A packaged practice page is a trusted extension page, but its runtime messages cannot read settings or mutate credentials.

Offline replays establish extension behavior and request construction. Real provider access and live Wooclap acceptance remain separate checks.
