import { applyOverrides } from "../test-connection/route"
import type { R2Settings } from "../../../../lib/settings"

const stored: R2Settings = {
  source: "admin",
  configured: true,
  missing: [],
  accountId: "0123456789abcdef0123456789abcdef",
  jurisdiction: "default",
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  endpointIsCustom: false,
  accessKeyId: "stored-key",
  secretAccessKey: "stored-secret",
  accessKeyIdHint: "••••-key",
  bucket: "media",
  publicUrl: "https://pub.r2.dev",
  publicUrlTemplate: null,
  prefix: "",
  privateBucket: null,
  cacheControl: "public",
  downloadUrlTtl: 60,
  uploadUrlTtl: 60,
  maxFileSize: null,
  maxAttempts: 4,
  connectionTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  credentialsSavedAt: null,
  encryption: { status: "ok", message: null },
  adminUnavailable: false,
}

describe("applyOverrides", () => {
  it("keeps stored values for fields not sent", () => {
    const s = applyOverrides(stored, {})
    expect(s).toEqual(stored)
  })
  it("uses typed credentials only as a pair", () => {
    expect(applyOverrides(stored, { access_key_id: "new" }).accessKeyId).toBe("stored-key")
    const s = applyOverrides(stored, { access_key_id: "new", secret_access_key: "new-secret" })
    expect(s.accessKeyId).toBe("new")
    expect(s.secretAccessKey).toBe("new-secret")
  })
  it("recomputes the endpoint from a typed account id / jurisdiction, custom endpoint wins", () => {
    expect(applyOverrides(stored, { jurisdiction: "eu" }).endpoint).toBe(
      "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com"
    )
    const custom = applyOverrides(stored, { endpoint: "http://127.0.0.1:59000/" })
    expect(custom.endpoint).toBe("http://127.0.0.1:59000")
    expect(custom.endpointIsCustom).toBe(true)
  })
  it("an emptied bucket makes the test not configured", () => {
    const s = applyOverrides(stored, { bucket: "" })
    expect(s.configured).toBe(false)
    expect(s.missing).toEqual(["bucket"])
  })
})
