import { model } from "@medusajs/framework/utils"

/**
 * Single-row table holding the store's Cloudflare R2 configuration.
 *
 * The file provider reads this table directly through the shared
 * `__pg_connection__` (see src/lib/settings.ts), so column renames here must
 * be mirrored there.
 */
const R2Setting = model.define("r2_setting", {
  id: model.id({ prefix: "r2set" }).primaryKey(),
  // Cloudflare account id (32 hex chars); not secret, but it is part of the endpoint
  account_id: model.text().nullable(),
  // "default" | "eu" | "fedramp": picks the R2 endpoint host
  jurisdiction: model.text().default("default"),
  // Custom S3 endpoint (MinIO, another S3-compatible store); empty = derived from account_id + jurisdiction
  endpoint: model.text().nullable(),
  access_key_id_encrypted: model.text().nullable(),
  // e.g. "••••a1b2"; safe to show in the Admin
  access_key_id_hint: model.text().nullable(),
  secret_access_key_encrypted: model.text().nullable(),
  encryption_key_fingerprint: model.text().nullable(),
  bucket: model.text().nullable(),
  // Where the bucket is served from: https://pub-xxxx.r2.dev or https://cdn.your-store.com (no trailing slash)
  public_url: model.text().nullable(),
  // Key prefix inside the bucket, e.g. "medusa/" ("" = bucket root)
  prefix: model.text().default(""),
  // Bucket for files Medusa marks private (exports, imports). Empty = same bucket as public files.
  private_bucket: model.text().nullable(),
  cache_control: model.text().default("public, max-age=31536000, immutable"),
  // Lifetime of presigned download URLs, seconds
  download_url_ttl: model.number().default(3600),
  // Lifetime of presigned upload URLs, seconds
  upload_url_ttl: model.number().default(3600),
  credentials_saved_at: model.dateTime().nullable(),
})

export default R2Setting
