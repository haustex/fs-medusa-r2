# CLAUDE.md — medusa-storage-r2 (Cloudflare R2 file storage by Haus Kayu)

## ⚠️ Server rules (read before doing anything)

This host also runs the **hauskayu.com production store**.

- **Never** send requests to ports `9000`, `8000`, `80`, `443`, `5432`, `6379` or any `*.hauskayu.com` domain from tests.
- **Never** touch the `hauskayu-*` containers.
- Test **only** on ports `9600+` and the `r2-spike-*` containers (Postgres `127.0.0.1:55435`, Redis `127.0.0.1:56382`,
  RustFS `127.0.0.1:59000`, container `r2-spike-minio`).
- Every medusa/db command goes **through `scripts/guard.mjs`**.
- **Never commit** secrets or `.env` files. Do not publish to npm or push to GitHub until the maintainer (Haus Kayu) says OK.

## Technical decisions

- Settings live in one row of `r2_setting` (module `r2Settings`). The provider reads it with raw knex through
  `__pg_connection__` from the File Module's container (`src/lib/settings.ts`), the same pattern as
  medusa-payment-doit: server and worker always agree, a 60 s cache (`settings_cache_ttl_ms`) saves round trips,
  the `r2.settings.updated` event clears other processes' caches.
- Priority Admin → provider options → `R2_*` env. Access key and secret always come from the **same** source.
- Secrets: AES-256-GCM with `R2_ENCRYPTION_KEY` (`src/lib/crypto.ts`, column name as AAD, key fingerprint stored).
  API responses only ever carry `access_key_id_hint`.
- R2 has no ACLs: never send `x-amz-acl`. Public vs private = which bucket (`private_bucket` optional). Reads and
  deletes of a bare key try the private bucket first (HEAD), then the public one.
- S3Client: `region: "auto"`, `forcePathStyle: true`, `requestChecksumCalculation/responseChecksumValidation:
  WHEN_REQUIRED` (R2 and RustFS reject CRC trailers). One client per (endpoint, key, secret).
- Public files need `public_url`; without it the provider returns a presigned link and warns. Not configured →
  `MedusaError.INVALID_DATA` with the Settings hint; Medusa itself keeps running.
- E2E uses RustFS (`rustfs/rustfs`, MinIO-compatible; the `minio/minio` images are no longer on public registries)
  with a public-read bucket policy standing in for r2.dev. Both suites: default (Admin-configured) and
  `R2_E2E_OPTIONS=1` (provider options only).
- Admin page layout (`md:grid-cols-[240px_1fr]`) is not picked up by Tailwind when the plugin is resolved from a local
  path in the test app; installed from npm it renders as in medusa-payment-doit.

- 0.2.0 decisions: private files without a private bucket are rejected (never public); content type is sniffed from
  the first 512 bytes (`src/lib/content-type.ts`); the upload stream is a Transform that holds the head until it
  can sniff, then feeds `@aws-sdk/lib-storage`; CORS is only touched by the Admin button (needs an Admin token);
  the change log stores field names only; `medusa exec` scripts take word arguments (`key=value`, no `--`).
- Live R2 suite: `R2_E2E_LIVE=1` + `R2_LIVE_*` (workflow `r2-live.yml`, environment `r2-live`); unique prefix per
  run, cleaned up in `finally`. Never put R2 credentials in the repo or in chat.

## Backlog

- Dashboard widget with bucket usage (needs the Cloudflare API, a different token than the S3 pair).
