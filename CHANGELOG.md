# Changelog

All notable changes to `medusa-storage-r2`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
