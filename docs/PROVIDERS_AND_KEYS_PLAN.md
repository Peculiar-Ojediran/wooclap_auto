# Claude and extension API keys

## Behavior

- Settings selects OpenAI or Claude (Anthropic) and an editable model. Existing installations keep their OpenAI model.
- Each provider has a separate key and stored-key status; the password input follows the selected provider and never reads saved keys back into the form.
- API keys use trusted extension session storage by default. They survive service-worker suspension but are cleared when the browser session ends or the extension is reloaded/disabled.
- Remembering a key requires an unchecked opt-in and an explicit confirmation explaining local storage. No cookies are used. Local extension storage is not an encrypted credential vault.
- Forget removes both session and remembered copies for the chosen provider. Saving a session key also removes any remembered copy. Environment keys on the bridge remain a separate fallback.

## Implementation

1. Add provider identifiers/default models and allowlist ordinary settings so credentials cannot be accidentally persisted with them.
2. Isolate credentials in a serialized vault restricted to trusted extension contexts. Return only configured/storage metadata to extension UI messages; content scripts receive neither credentials nor settings.
3. Pause and cancel pending answers on credential changes, discard their cached answers, and preserve consumed request claims against duplicate submissions.
4. Extend authenticated localhost requests with provider and an optional per-request key. The bridge strips the key before calling a solver and stores no browser-supplied keys. Environment variables remain supported.
5. Add Claude Messages requests with text/image inputs and structured JSON outputs, using the existing answer schemas, validation, cancellation, timeout, and no-retry behavior.
6. Advertise provider readiness and credential support in bridge health while preserving protocol 2. Require an updated bridge for Claude or extension-supplied keys; retain legacy OpenAI environment-key operation.
7. Attribute answers to the selected provider and isolate caches by provider/model. Existing foreground and background capture remain unchanged.

## Verification

- Injected provider transport tests cover request construction, every answer family, image encoding, strict validation, refusals/truncation, errors, redaction, deadlines, and cancellation.
- Bridge tests cover provider routing, environment fallback, per-request overrides, unknown providers, and key stripping.
- Vault/background/UI tests cover session-only defaults, denied permission, remembered keys, replacement/forget, reload behavior, trusted-context boundaries, and startup cancellation.
- An isolated Edge profile exercises the settings UI and real extension storage with synthetic keys and an injected local solver; it makes no paid provider calls.
- Run the complete automated suite and existing browser/background checks, rebuild `dist/edge`, and refresh `dist/edge.zip`.

## API references

- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic model identifiers](https://platform.claude.com/docs/en/models/overview)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview)

Live Claude account access and live Wooclap acceptance require a configured user key/event; local tests do not establish either.
