import type { Knex } from "@medusajs/framework/mikro-orm/knex"
import { decryptSecret, loadEncryptionKey } from "./crypto"
import { maskSecret } from "./mask"

/**
 * Resolves the Cloudflare R2 configuration for the current process.
 *
 * Source of truth is the `r2_setting` table (written by the Admin, secrets
 * encrypted). It is read straight from the database so the server and the
 * worker process always agree; an in-memory cache with a short TTL only saves
 * round trips. Saving settings clears the cache in the saving process directly
 * and in other processes through the `r2.settings.updated` event, so the TTL is
 * the upper bound on staleness.
 *
 * Priority: Admin (database) → provider options → environment variables. The
 * access key and its secret always come from the same source. Nothing in here
 * throws: a broken key or a missing table degrades to the next source and is
 * reported through `encryption`.
 */

export const R2_SETTINGS_TABLE = "r2_setting"
export const R2_SETTINGS_UPDATED_EVENT = "r2.settings.updated"
export const DEFAULT_CACHE_TTL_MS = 60_000

export const JURISDICTIONS = ["default", "eu", "fedramp"] as const
export type Jurisdiction = (typeof JURISDICTIONS)[number]
export type SettingsSource = "admin" | "options" | "env" | "none"

export type EncryptionStatus =
  // stored secrets decrypted fine
  | "ok"
  // no secrets stored in the Admin, so the key is not needed
  | "unused"
  // secrets are stored but R2_ENCRYPTION_KEY is unset / not 64 hex chars
  | "missing"
  | "malformed"
  // R2_ENCRYPTION_KEY differs from the one used to encrypt, or ciphertext is corrupt
  | "mismatch"

export const ENCRYPTION_KEY_INVALID_MESSAGE =
  "R2_ENCRYPTION_KEY is missing, malformed or not the key the credentials were saved with. Re-enter the access key and secret in Settings → Cloudflare R2."

export const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable"
export const DEFAULT_URL_TTL = 3600

/** Options of the provider entry in `medusa-config.ts`; every field optional, the Admin settings take precedence. */
export type R2ProviderOptions = {
  account_id?: string
  jurisdiction?: Jurisdiction
  /** Custom S3 endpoint; overrides account_id + jurisdiction (MinIO, another S3-compatible store) */
  endpoint?: string
  access_key_id?: string
  secret_access_key?: string
  bucket?: string
  /** https://pub-xxx.r2.dev or https://cdn.your-store.com */
  public_url?: string
  prefix?: string
  private_bucket?: string
  cache_control?: string
  download_url_ttl?: number
  upload_url_ttl?: number
  /** How long resolved settings are cached in this process. Default 60000. */
  settings_cache_ttl_ms?: number
}

export type R2Settings = {
  source: SettingsSource
  /** Endpoint, credentials and bucket are all known: uploads can be attempted. */
  configured: boolean
  /** Required fields still unknown (empty when configured) */
  missing: ("endpoint" | "access_key_id" | "secret_access_key" | "bucket")[]
  accountId: string | null
  jurisdiction: Jurisdiction
  /** Resolved S3 endpoint (custom, or derived from the account id) */
  endpoint: string | null
  endpointIsCustom: boolean
  accessKeyId: string | null
  secretAccessKey: string | null
  accessKeyIdHint: string | null
  bucket: string | null
  /** No trailing slash; null = files get no public URL (presigned download URLs only) */
  publicUrl: string | null
  /** "" or "folder/" (always a trailing slash when set) */
  prefix: string
  privateBucket: string | null
  cacheControl: string
  downloadUrlTtl: number
  uploadUrlTtl: number
  credentialsSavedAt: Date | null
  encryption: { status: EncryptionStatus; message: string | null }
  /** true when the Admin row holds credentials that could not be decrypted */
  adminUnavailable: boolean
}

type StoredSettingRow = {
  account_id: string | null
  jurisdiction: string | null
  endpoint: string | null
  access_key_id_encrypted: string | null
  access_key_id_hint: string | null
  secret_access_key_encrypted: string | null
  encryption_key_fingerprint: string | null
  bucket: string | null
  public_url: string | null
  prefix: string | null
  private_bucket: string | null
  cache_control: string | null
  download_url_ttl: number | null
  upload_url_ttl: number | null
  credentials_saved_at: Date | string | null
}

type AdminLookup = {
  row: StoredSettingRow | null
  accessKeyId: string | null
  secretAccessKey: string | null
  status: EncryptionStatus
}

type CacheEntry = { value: AdminLookup; expiresAt: number }

// Kept on globalThis so every copy of this file loaded in the process
// (provider, API routes, subscriber) shares one cache.
const CACHE_KEY = Symbol.for("medusa-storage-r2.settings-cache")
type CacheHolder = { [CACHE_KEY]?: CacheEntry | null }
const holder = globalThis as CacheHolder

export function invalidateR2SettingsCache(): void {
  holder[CACHE_KEY] = null
}

export function accessKeyIdHint(accessKeyId: string): string {
  return maskSecret(accessKeyId) ?? ""
}

export function isJurisdiction(value: unknown): value is Jurisdiction {
  return typeof value === "string" && (JURISDICTIONS as readonly string[]).includes(value)
}

/** `https://<account>.r2.cloudflarestorage.com`, with the jurisdiction host when not default */
export function r2EndpointFor(accountId: string, jurisdiction: Jurisdiction): string {
  const host = jurisdiction === "default" ? "r2.cloudflarestorage.com" : `${jurisdiction}.r2.cloudflarestorage.com`
  return `https://${accountId}.${host}`
}

/** Trailing slashes removed; empty → null */
export function normalizePublicUrl(value: string | null | undefined): string | null {
  const v = value?.trim().replace(/\/+$/, "")
  return v ? v : null
}

/** "" or "a/b/" : leading slashes dropped, exactly one trailing slash, no empty segments */
export function normalizePrefix(value: string | null | undefined): string {
  const segments = (value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
  return segments.length ? `${segments.join("/")}/` : ""
}

function clean(value: string | null | undefined): string | null {
  const v = value?.trim()
  return v ? v : null
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

type Logger = { warn: (msg: string) => void }

export async function resolveR2Settings(
  pg: Knex | undefined,
  options: R2ProviderOptions = {},
  { logger, fresh = false }: { logger?: Logger; fresh?: boolean } = {}
): Promise<R2Settings> {
  const admin = await lookupAdmin(pg, options, { logger, fresh })
  const row = admin.row
  const adminUnavailable =
    !!row && (!!row.access_key_id_encrypted || !!row.secret_access_key_encrypted) && admin.status !== "ok"
  const env = process.env

  // Credentials: one source for both halves, so a key is never paired with another store's secret.
  let source: SettingsSource = "none"
  let accessKeyId: string | null = null
  let secretAccessKey: string | null = null
  if (admin.accessKeyId && admin.secretAccessKey) {
    source = "admin"
    accessKeyId = admin.accessKeyId
    secretAccessKey = admin.secretAccessKey
  } else if (clean(options.access_key_id) && clean(options.secret_access_key)) {
    source = "options"
    accessKeyId = clean(options.access_key_id)
    secretAccessKey = clean(options.secret_access_key)
  } else if (clean(env.R2_ACCESS_KEY_ID) && clean(env.R2_SECRET_ACCESS_KEY)) {
    source = "env"
    accessKeyId = clean(env.R2_ACCESS_KEY_ID)
    secretAccessKey = clean(env.R2_SECRET_ACCESS_KEY)
  }

  // Everything else: Admin value when set, else options, else env.
  const pick = (adminValue: string | null | undefined, optionValue: string | undefined, envName: string) =>
    clean(adminValue) ?? clean(optionValue) ?? clean(env[envName])

  const accountId = pick(row?.account_id, options.account_id, "R2_ACCOUNT_ID")
  const jurisdictionRaw = pick(row?.jurisdiction, options.jurisdiction, "R2_JURISDICTION")
  const jurisdiction: Jurisdiction = isJurisdiction(jurisdictionRaw) ? jurisdictionRaw : "default"
  const customEndpoint = normalizePublicUrl(pick(row?.endpoint, options.endpoint, "R2_ENDPOINT"))
  const endpoint = customEndpoint ?? (accountId ? r2EndpointFor(accountId, jurisdiction) : null)
  const bucket = pick(row?.bucket, options.bucket, "R2_BUCKET")

  const missing: R2Settings["missing"] = []
  if (!endpoint) missing.push("endpoint")
  if (!accessKeyId) missing.push("access_key_id")
  if (!secretAccessKey) missing.push("secret_access_key")
  if (!bucket) missing.push("bucket")

  return {
    source,
    configured: missing.length === 0,
    missing,
    accountId,
    jurisdiction,
    endpoint,
    endpointIsCustom: !!customEndpoint,
    accessKeyId,
    secretAccessKey,
    accessKeyIdHint:
      source === "admin" ? (row?.access_key_id_hint ?? null) : accessKeyId ? accessKeyIdHint(accessKeyId) : null,
    bucket,
    publicUrl: normalizePublicUrl(pick(row?.public_url, options.public_url, "R2_PUBLIC_URL")),
    prefix: normalizePrefix(pick(row?.prefix, options.prefix, "R2_PREFIX")),
    privateBucket: pick(row?.private_bucket, options.private_bucket, "R2_PRIVATE_BUCKET"),
    cacheControl: pick(row?.cache_control, options.cache_control, "R2_CACHE_CONTROL") ?? DEFAULT_CACHE_CONTROL,
    downloadUrlTtl: positiveInt(row?.download_url_ttl ?? options.download_url_ttl, DEFAULT_URL_TTL),
    uploadUrlTtl: positiveInt(row?.upload_url_ttl ?? options.upload_url_ttl, DEFAULT_URL_TTL),
    credentialsSavedAt: toDateOrNull(row?.credentials_saved_at),
    encryption: {
      status: admin.status,
      message: adminUnavailable ? ENCRYPTION_KEY_INVALID_MESSAGE : null,
    },
    adminUnavailable,
  }
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null
  }
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

const COLUMNS = [
  "account_id",
  "jurisdiction",
  "endpoint",
  "access_key_id_encrypted",
  "access_key_id_hint",
  "secret_access_key_encrypted",
  "encryption_key_fingerprint",
  "bucket",
  "public_url",
  "prefix",
  "private_bucket",
  "cache_control",
  "download_url_ttl",
  "upload_url_ttl",
  "credentials_saved_at",
] as const

async function lookupAdmin(
  pg: Knex | undefined,
  options: R2ProviderOptions,
  { logger, fresh }: { logger?: Logger; fresh: boolean }
): Promise<AdminLookup> {
  const cached = holder[CACHE_KEY]
  if (!fresh && cached && cached.expiresAt > Date.now()) {
    return cached.value
  }
  const value = await readAdminSettings(pg, logger)
  const ttl = options.settings_cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS
  holder[CACHE_KEY] = { value, expiresAt: Date.now() + ttl }
  return value
}

async function readAdminSettings(pg: Knex | undefined, logger?: Logger): Promise<AdminLookup> {
  const empty: AdminLookup = { row: null, accessKeyId: null, secretAccessKey: null, status: "unused" }
  if (!pg) {
    return empty
  }

  let row: StoredSettingRow | undefined
  try {
    row = await pg<StoredSettingRow>(R2_SETTINGS_TABLE)
      .select(...COLUMNS)
      .whereNull("deleted_at")
      .orderBy("updated_at", "desc")
      .first()
  } catch (e) {
    // Most likely migrations have not been run yet.
    logger?.warn(
      `[r2] Could not read ${R2_SETTINGS_TABLE} (${(e as Error).message}); falling back to provider options / env. Run \`npx medusa db:migrate\`.`
    )
    return empty
  }

  if (!row) {
    return empty
  }
  if (!row.access_key_id_encrypted && !row.secret_access_key_encrypted) {
    return { ...empty, row }
  }

  const key = loadEncryptionKey()
  if (key.status !== "ok") {
    return { ...empty, row, status: key.status }
  }
  if (row.encryption_key_fingerprint && row.encryption_key_fingerprint !== key.fingerprint) {
    return { ...empty, row, status: "mismatch" }
  }

  try {
    return {
      row,
      accessKeyId: row.access_key_id_encrypted
        ? decryptSecret(row.access_key_id_encrypted, key.key, "access_key_id")
        : null,
      secretAccessKey: row.secret_access_key_encrypted
        ? decryptSecret(row.secret_access_key_encrypted, key.key, "secret_access_key")
        : null,
      status: "ok",
    }
  } catch {
    return { ...empty, row, status: "mismatch" }
  }
}
