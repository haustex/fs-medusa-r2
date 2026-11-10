import { encryptSecret, keyFingerprint } from "../crypto"
import {
  invalidateR2SettingsCache,
  normalizePrefix,
  normalizePublicUrl,
  r2EndpointFor,
  resolveR2Settings,
} from "../settings"

const KEY_HEX = "a".repeat(64)
const KEY = Buffer.from(KEY_HEX, "hex")

type Row = Record<string, unknown>
/** Minimal knex stand-in: `pg(table).select(...).whereNull().orderBy().first()` */
function fakePg(row: Row | null | Error) {
  const chain = {
    select: () => chain,
    whereNull: () => chain,
    orderBy: () => chain,
    first: async () => {
      if (row instanceof Error) throw row
      return row ?? undefined
    },
  }
  return (() => chain) as never
}

const ENV = ["R2_ENCRYPTION_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL", "R2_PREFIX", "R2_ENDPOINT", "R2_JURISDICTION"]
beforeEach(() => {
  invalidateR2SettingsCache()
  for (const k of ENV) delete process.env[k]
})

describe("normalizers", () => {
  it("prefix", () => {
    expect(normalizePrefix(undefined)).toBe("")
    expect(normalizePrefix(" /medusa// ")).toBe("medusa/")
    expect(normalizePrefix("a/../b")).toBe("a/b/")
  })
  it("public url and endpoint", () => {
    expect(normalizePublicUrl(" https://cdn.x/// ")).toBe("https://cdn.x")
    expect(normalizePublicUrl("")).toBeNull()
    expect(r2EndpointFor("abc", "default")).toBe("https://abc.r2.cloudflarestorage.com")
    expect(r2EndpointFor("abc", "eu")).toBe("https://abc.eu.r2.cloudflarestorage.com")
  })
})

describe("resolveR2Settings", () => {
  it("is not configured when nothing is set and lists what is missing", async () => {
    const s = await resolveR2Settings(undefined, {})
    expect(s.configured).toBe(false)
    expect(s.missing).toEqual(["endpoint", "access_key_id", "secret_access_key", "bucket"])
    expect(s.source).toBe("none")
  })

  it("reads the Admin row and decrypts the credentials", async () => {
    process.env.R2_ENCRYPTION_KEY = KEY_HEX
    const row = {
      account_id: "0123456789abcdef0123456789abcdef",
      jurisdiction: "eu",
      endpoint: null,
      access_key_id_encrypted: encryptSecret("AKIA1234567890", KEY, "access_key_id"),
      access_key_id_hint: "••••7890",
      secret_access_key_encrypted: encryptSecret("secret-value", KEY, "secret_access_key"),
      encryption_key_fingerprint: keyFingerprint(KEY),
      bucket: "media",
      public_url: "https://pub.r2.dev/",
      prefix: "medusa",
      private_bucket: null,
      cache_control: null,
      download_url_ttl: 120,
      upload_url_ttl: null,
      credentials_saved_at: "2026-11-10T00:00:00.000Z",
    }
    const s = await resolveR2Settings(fakePg(row), { bucket: "ignored", public_url: "https://ignored" })
    expect(s.configured).toBe(true)
    expect(s.source).toBe("admin")
    expect(s.endpoint).toBe("https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com")
    expect(s.accessKeyId).toBe("AKIA1234567890")
    expect(s.secretAccessKey).toBe("secret-value")
    expect(s.accessKeyIdHint).toBe("••••7890")
    expect(s.bucket).toBe("media")
    expect(s.publicUrl).toBe("https://pub.r2.dev")
    expect(s.prefix).toBe("medusa/")
    expect(s.downloadUrlTtl).toBe(120)
    expect(s.uploadUrlTtl).toBe(3600)
    expect(s.cacheControl).toBe("public, max-age=31536000, immutable")
    expect(s.credentialsSavedAt?.toISOString()).toBe("2026-11-10T00:00:00.000Z")
    expect(s.encryption.status).toBe("ok")
  })

  it("falls back to options, then env, and never mixes a key with another source's secret", async () => {
    process.env.R2_ACCESS_KEY_ID = "env-key"
    process.env.R2_SECRET_ACCESS_KEY = "env-secret"
    process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
    const onlyKey = await resolveR2Settings(undefined, { access_key_id: "opt-key", bucket: "b" })
    expect(onlyKey.source).toBe("env")
    expect(onlyKey.accessKeyId).toBe("env-key")
    expect(onlyKey.configured).toBe(true)
    expect(onlyKey.endpoint).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com")

    invalidateR2SettingsCache()
    const both = await resolveR2Settings(undefined, { access_key_id: "opt-key", secret_access_key: "opt-secret" })
    expect(both.source).toBe("options")
    expect(both.secretAccessKey).toBe("opt-secret")
  })

  it("reports a wrong encryption key and does not use the stored credentials", async () => {
    process.env.R2_ENCRYPTION_KEY = "b".repeat(64)
    const row = {
      access_key_id_encrypted: encryptSecret("k", KEY, "access_key_id"),
      secret_access_key_encrypted: encryptSecret("s", KEY, "secret_access_key"),
      encryption_key_fingerprint: keyFingerprint(KEY),
      bucket: "media",
      account_id: "0123456789abcdef0123456789abcdef",
    }
    const s = await resolveR2Settings(fakePg(row), {})
    expect(s.encryption.status).toBe("mismatch")
    expect(s.adminUnavailable).toBe(true)
    expect(s.accessKeyId).toBeNull()
    expect(s.configured).toBe(false)
    expect(s.encryption.message).toMatch(/R2_ENCRYPTION_KEY/)
  })

  it("survives a missing table (migration not run) by falling back", async () => {
    const warn = jest.fn()
    const s = await resolveR2Settings(fakePg(new Error('relation "r2_setting" does not exist')), { bucket: "b" }, { logger: { warn } })
    expect(s.bucket).toBe("b")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db:migrate"))
  })

  it("caches the row between calls until invalidated or fresh is requested", async () => {
    const first = fakePg({ bucket: "one" })
    const second = fakePg({ bucket: "two" })
    expect((await resolveR2Settings(first, {})).bucket).toBe("one")
    expect((await resolveR2Settings(second, {})).bucket).toBe("one")
    expect((await resolveR2Settings(second, {}, { fresh: true })).bucket).toBe("two")
  })
})
