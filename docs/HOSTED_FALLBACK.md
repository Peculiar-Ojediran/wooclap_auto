# Deploy the shared NVIDIA fallback

The service is implemented for Cloudflare Workers with one SQLite Durable Object coordinating usage across all clients and worker instances. Users of a configured extension build need no terminal, bridge token, cookies, or personal API key. The operator performs the deployment once.

No service has been deployed by this change. No real NVIDIA request was made. Until deployment and the extension URL are configured, the built extension explicitly reports the shared service unavailable and supports personal API keys or offline practice.

## Operator setup

From the repository root, install the root dependencies with `npm ci`, then:

```powershell
npm ci --prefix hosted
Set-Location hosted
npx wrangler login
npx wrangler secret put NVIDIA_API_KEY
```

Enter the NVIDIA key at Wrangler's secret prompt; do not put it in source code, `.gitignore`, a filename, the extension, or chat. Wrangler stores the secret on the hosted service. For local development only, `hosted/.dev.vars` is ignored. Personal keys entered in extension Settings remain separate and never become the operator's shared key.

In `hosted/wrangler.jsonc`, set `ENABLED` to `"true"`. Review the budget values and keep `ALLOWED_EXTENSION_IDS` set to the shared-build ID printed by the build (currently `moikjafognlalmecmnpplapgponcnhfn`). It is derived from the committed **public** key in `extension/hosted-public-key.txt`; no private signing key was stored. For an Edge Add-ons distribution, configure its assigned extension ID instead. Additional IDs are comma-separated.

```powershell
npm run build
npm run deploy
```

The first command is a local dry run. The second deploys to your Cloudflare account and prints the public HTTPS service URL. If adding the secret creates an initial disabled Worker, deploy after configuring the variables. Use an NVIDIA account whose terms permit your intended shared deployment: the build page's prototype endpoint is not a promise of an unrestricted public production service. Review [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf) and [NVIDIA's API FAQ](https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317).

## Build and distribute the connected extension

Return to the repository root and set only the **public origin**. Substitute the URL printed by your deployment:

```powershell
Set-Location ..
$env:HOSTED_FALLBACK_URL = 'https://your-worker.your-subdomain.workers.dev'
npm run build
Compress-Archive -Path dist/edge -DestinationPath dist/edge.zip -Force
Remove-Item Env:HOSTED_FALLBACK_URL
```

The build does not read `.env` and never embeds API keys. It adds only the service's exact origin to host permissions/CSP and inserts the public manifest identity. The URL must be an HTTPS origin without a port, path, credentials, query, or fragment. Every later rebuild must set the URL again; leaving it unset deliberately produces a build without shared access.

Load the resulting `dist/edge` folder in `edge://extensions`, or distribute the ZIP. Shared builds use the same extension ID on different machines. An earlier unpacked install without the public key has a different ID: load the shared build as a new extension if reloading is refused, then re-enter its settings/keys. Confirm the ID matches the server allowlist.

In Settings, leave **Automatic / own API key** selected, choose **Save & check connection**, and check the shared-service readiness message. A health check does not validate NVIDIA credentials. Start on the bundled practice page in suggestion mode for the first real model check. That request consumes the operator's NVIDIA allowance. A user's own saved key takes priority; an invalid saved key fails without using shared credits.

## Budgets and exposure

| Setting | Default | Meaning |
| --- | --- | --- |
| ENABLED | false | Immediate service switch; redeploy false to stop new solves |
| DAILY_REQUEST_LIMIT | 100 | Shared requests per UTC day; maximum configurable 500 |
| DAILY_INPUT_BYTES | 20 MiB | Shared accepted input bytes per UTC day |
| IP_REQUESTS_PER_MINUTE | 6 | Rolling minute allowance per network address |
| IP_REQUESTS_PER_DAY | 30 | Per network address per UTC day |
| MAX_CONCURRENT_REQUESTS | 2 | Active upstream calls across the deployment |

Allowances are persisted and atomically reserved before NVIDIA is called. Failed/cancelled requests still consume allowance because upstream usage may already have occurred. Concurrency leases expire after 60 seconds if cleanup is interrupted; normal calls time out within 28 seconds. Model output is capped at 6,000 tokens and request bodies at 5.7 MB. These bound request exposure, not exact dollar cost; provider account spending controls remain separate. Users behind one NAT share network limits.

The endpoint intentionally requires no reusable client secret. **Origin matching is not authentication**: a non-browser client can spoof it. Global persistent quotas protect the shared allowance even if a caller changes IP or copies the extension ID. A public service can still be deliberately exhausted; larger deployments should add individual authentication/quotas before increasing the shared budget. Changing the Durable Object name or binding starts a new budget store and must not be used to bypass accounting.

The service does not persist question text, screenshots, answers, or raw IPs. Daily HMAC hashes, request counts, byte counts, and lease expiry times are stored for rate limiting; the next-day alarm removes stale client records. Cloudflare's storage backups/retention remain platform-controlled. Worker observability is disabled in the included configuration. NVIDIA receives the question and screenshots; its own retention policies apply. No cookies or personal user API keys are accepted by `/solve`.

## Local verification

```powershell
npm run check
npm run test:standalone
npm run test:hosted
npm run test:hosted:runtime
```

The two browser commands use isolated offline Edge profiles and synthetic responses. The hosted browser check builds a temporary fixture extension and never replaces the distributed service URL. The runtime check builds the actual Worker, runs it in Miniflare/workerd, substitutes only the NVIDIA network response, and verifies that the Durable Object daily limit survives restart. None of these commands uses your NVIDIA secret or makes a paid API request.

The implementation follows Cloudflare's [SQLite Durable Object storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Workers secrets workflow](https://developers.cloudflare.com/workers/configuration/secrets/).
