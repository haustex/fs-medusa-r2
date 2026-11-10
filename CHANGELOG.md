# Changelog

All notable changes to `medusa-storage-r2`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-10

### Changed (behaviour)

- **Private files are rejected when no private bucket is set.** 0.1 stored them in the public bucket with a
  presigned link; a public bucket serves every key, so this was a leak waiting to happen. The upload now fails
  with `This file is private … set a private bucket in Settings → Cloudflare R2.` (`NOT_ALLOWED`).
- Content type is taken from the file's first bytes (PNG, JPEG, WebP, AVIF, HEIC, GIF, BMP, TIFF, ICO, SVG, PDF,
  ZIP, GZIP, MP4, MOV, WebM, MP3, OGG, WOFF/WOFF2) and only then from the declared type / extension. Zip
  containers keep a specific declared type (docx, xlsx).
- Private objects are stored with `Cache-Control: private, no-store` regardless of the configured Cache-Control.
- Multipart file names that busboy decoded as latin1 are repaired to UTF-8 before the key is built.
- The S3 client retries transient errors (5xx, 429, network) with adaptive backoff, 4 attempts, and has a 5 s
  connection / 30 s request timeout; 4xx errors are never retried.

### Added

- `max_file_size` provider option, enforced for buffered uploads and while streaming (the multipart upload is
  aborted and its parts removed).
- **CORS**: `cors` check in Test connection (warning only), `POST /admin/r2/cors` + **Apply CORS** button that merges
  a rule for the Admin origin into the bucket policy; when the token lacks Admin rights the response carries the
  policy JSON to paste in the Cloudflare dashboard.
- **Change log** `r2_setting_event`: every save, credential removal, CORS change and key rotation with the Admin
  user's id and e-mail, the time and the field names (never values); listed on the settings page and in
  `GET /admin/r2/settings` (`events`).
- `rotate-encryption-key` script for `medusa exec`: re-encrypts the stored credentials with a new
  `R2_ENCRYPTION_KEY` (old key in `R2_ENCRYPTION_KEY_OLD`), refuses the wrong old key.
- `migrate-to-r2` script for `medusa exec`: copies the files behind `image.url`, `product.thumbnail` (and any
  `tables=<table>.<column>`) from `file-local`'s `static/` or an S3 bucket to R2 under the same path, sniffs the
  content type, verifies size and MD5 (single-part) and records SHA-256, writes a CSV report, rewrites the URLs
  only after verification, supports `dry-run`, `resume`, `rollback`, `rewrite=no`. Sources are never deleted.
- `public_url_template` (Admin field, option, `R2_PUBLIC_URL_TEMPLATE`): e.g.
  `{public_url}/cdn-cgi/image/format=auto,quality=85/{key}` for Cloudflare Image Transformations. Off by default.
- `max_attempts`, `connection_timeout_ms`, `request_timeout_ms` provider options.
- Test connection treats a 403 on `HeadBucket` as a warning (an Object Read & Write token may not HEAD the
  bucket) and lets the probe object decide; a 403 on the probe write too is reported as wrong credentials / token
  scope. The private bucket is proven with a probe write when HEAD is refused.
- Live E2E against a real R2 bucket (`R2_E2E_LIVE=1`, workflow "R2 live": weekly + manual, GitHub Environment
  `r2-live`, skipped without credentials). Unique prefix per run, cleaned up afterwards.
- E2E coverage: private rejection (buffer and stream), 12 MB chunked stream upload without content-length, unicode
  / space / `#` names, sniffing, private Cache-Control, CORS, change log, template, key rotation, migration
  (dry-run, copy, resume, failure, rollback). 75 checks + 32 unit tests.
- README: least-privilege token, CORS, private files, migration, Next.js `remotePatterns`, key rotation,
  troubleshooting table, live-test setup.

### Migration

`npx medusa db:migrate` adds `r2_setting.public_url_template` and the `r2_setting_event` table. Until it runs the
provider keeps working without the template (a warning is logged once).

## [0.1.1] - 2026-11-10

Same code as 0.1.0, published from GitHub Actions through npm trusted publishing with provenance (0.1.0 was
published by hand).

## [0.1.0] - 2026-11-10

First release.

### Added

- File Module provider `fs_r2_<id>` for Cloudflare R2 (and any S3-compatible store through a custom endpoint):
  upload, upload stream, delete (single and bulk), presigned download URLs, presigned upload URLs, download stream,
  buffer.
- **Settings → Cloudflare R2** in the Admin: account ID, jurisdiction (default / EU / FedRAMP), custom endpoint,
  access key + secret (stored AES-256-GCM encrypted with `R2_ENCRYPTION_KEY`, shown masked), bucket, public URL,
  folder prefix, optional private bucket, Cache-Control, lifetimes of presigned links. Saved settings apply to the
  next upload, no restart.
- **Test connection**: HEAD bucket, write / read / delete a probe object, fetch it through the public URL, HEAD
  the private bucket; each step reported separately. Values typed in the form are tested before they are saved.
- Fallbacks: provider options in `medusa-config.ts`, then `R2_*` environment variables, with the access key and
  secret always taken from the same source.
- Files Medusa marks private go to the private bucket when one is set; reads and deletes find them in either
  bucket. Public files need a public URL; without one they get a temporary presigned link and a warning is logged.
- Clear error when uploads are attempted before the store is configured, pointing at the Settings page.
- English and Indonesian Admin texts.
