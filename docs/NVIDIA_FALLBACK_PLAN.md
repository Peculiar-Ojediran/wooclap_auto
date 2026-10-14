# NVIDIA default and shared fallback

## Accepted behavior

- Default model: `deepseek-ai/deepseek-v4.1-flash`, provider NVIDIA.
- Automatic connection: use the selected provider's saved personal key directly; otherwise use the shared hosted NVIDIA service. Never retry or switch providers after an API error.
- The operator's shared NVIDIA key is a server secret. It is never compiled into the extension, returned by health checks, or sent to participants.
- Keep personal keys session-only unless the user explicitly confirms persistence. No cookies.
- Preserve explicit bridge/demo choices, foreground defaults, background opt-in, question identity checks, budgets, cancellation, and duplicate-submission safeguards.

## API research

The [NVIDIA model page](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash) specifies `https://integrate.api.nvidia.com/v1/chat/completions`, bearer authentication, and the exact namespaced model ID. The [model reference](https://docs.api.nvidia.com/nim/reference/nvidia-deepseek-v4_1-flash) lists text and image input. Its embedded request schema documents model, messages, max_tokens, stream, temperature, and top_p; it does not advertise response_format or reasoning controls. The implementation sends only documented fields, inline image_url blocks, and a strict answer schema in the system prompt. Final JSON passes all existing question-specific validation; reasoning, fences, partial answers, refusals, and tool calls never become submissions.

## Implementation

1. Extend provider/model settings, namespaced model validation, credential vault, direct and optional bridge routing.
2. Add a browser/server NVIDIA adapter with a 25-second complete-response deadline, cancellation, static errors, no retries, and output limited to 4,096–6,000 tokens.
3. Add a hosted client with a build-time HTTPS origin, scoped host permission/CSP, no credentials, fixed provider/model, privacy-minimized question identifiers, and strict response validation.
4. Freeze actual provider/model/transport at Start; separate hosted/direct caches and show actual source in the popup.
5. Deployable Cloudflare Worker: server-only NVIDIA key, fixed request contract, origin allowlist, persisted atomic daily/per-network budgets, concurrency leases, upload/response bounds, and an off-by-default switch.
6. Use a public manifest key for stable shared-build identity. Existing builds without a service URL retain their prior identity.
7. Verify adapter, extension, and service with deterministic fixtures, actual Edge, and the local Workers runtime. Package the normal extension with honest unavailable status until deployment is configured.

Implementation and local verification are complete. Live deployment and NVIDIA account verification require the operator's hosting account and server secret; see [deployment instructions](HOSTED_FALLBACK.md). Mocked checks establish protocol/lifecycle behavior, not real model accuracy or live Wooclap acceptance.
