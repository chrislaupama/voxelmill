# VoxelMill AI worker

The palette endpoint is fail-closed around paid Workers AI inference. The committed production configuration keeps inference disabled, so deploying this Worker does not call Workers AI until the feature is deliberately enabled.

## Runtime controls

- `AI_PALETTE_ENABLED`: only the literal value `true` enables palette inference.
- `AI_PALETTE_MODEL`: Workers AI model name used for palette generation.
- `AI_DAILY_REQUEST_LIMIT`: global inference-attempt allowance for each UTC day (`0` disables all attempts).
- `AI_REQUEST_DEADLINE_MS`: end-to-end palette request deadline, from `1000` to `60000` ms.
- `AI_RATE_LIMIT_HASH_KEY`: secret used to HMAC Cloudflare's edge-provided caller address before it is used as a short-lived rate-limit key. It must be set with Wrangler and must not be committed.

Wrangler currently sets `AI_PALETTE_ENABLED=false`, a 100-attempt daily ceiling, and a 20-second deadline. One globally named SQLite Durable Object atomically reserves an attempt immediately before `AI.run`. A failed or timed-out inference still consumes its reservation, which keeps the ceiling conservative. If configuration, caller derivation, rate limiting, storage, or the allowance response is invalid, inference is not called.

Palette POSTs and CORS preflights require an exact trusted production or local-development `Origin`; branch-preview wildcard origins are not accepted. The client cannot select its own limiter identity. The Worker derives a daily rotating opaque HMAC from Cloudflare's `CF-Connecting-IP` value, applies a per-caller burst limit plus an aggregate edge limit, and sends only the global limit to the allowance object. Cloudflare Rate Limiting necessarily keeps short-lived counters under that opaque key; the raw address is never used as a counter key. Raw addresses, opaque caller keys, request IDs, prompts, and palettes are never written to application or Durable Object storage.

Workers Logs, invocation logs, and traces are disabled in the committed configuration. When AI is enabled, the prompt and summarized palette are still sent to Workers AI for inference. Origin checks are a browser boundary, not bot authentication; add Turnstile or an equivalent server-verified challenge and suitable WAF rules before enabling public inference.

## Enabling inference deliberately

1. Add the uncommitted HMAC secret:

   ```sh
   npx wrangler secret put AI_RATE_LIMIT_HASH_KEY --config workers/ai-api/wrangler.jsonc
   ```

2. Add and verify server-side bot controls.
3. Change `AI_PALETTE_ENABLED` to `true`, review the daily ceiling, and deploy.
4. Build the frontend with `VITE_AI_PALETTE_ENABLED=true` only after the protected Worker is live; without that explicit build flag the AI source remains visibly paused.

The local reference-image palette workflow does not use this Worker and remains available while AI is disabled.

## Verification

```sh
npm test -- workers/ai-api/src/index.test.ts workers/ai-api/src/inferenceAllowance.test.ts workers/ai-api/src/wranglerConfig.test.ts
WRANGLER_LOG_PATH=/tmp/voxelmill-ai-wrangler.log npm run build:api
```
