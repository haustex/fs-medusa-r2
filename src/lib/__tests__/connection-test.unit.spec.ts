import type { S3Client } from "@aws-sdk/client-s3"
import { testConnection } from "../connection-test"
import type { R2Settings } from "../settings"

const settings: R2Settings = {
  source: "admin",
  configured: true,
  missing: [],
  accountId: "0123456789abcdef0123456789abcdef",
  jurisdiction: "default",
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  endpointIsCustom: false,
  accessKeyId: "key",
  secretAccessKey: "secret",
  accessKeyIdHint: "••••-key",
  bucket: "media",
  publicUrl: null,
  publicUrlTemplate: null,
  prefix: "p/",
  privateBucket: "private-media",
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

const forbidden = () => Object.assign(new Error("Forbidden"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
const notFound = () => Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })

/** S3 client stand-in: HEAD bucket behaves as configured, object operations work and remember the body */
function fakeClient(headBucket: "ok" | "forbidden" | "notfound", putObject: "ok" | "forbidden" = "ok") {
  const objects = new Map<string, string>()
  const sent: string[] = []
  const client = {
    destroy() {},
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push(cmd.constructor.name)
      switch (cmd.constructor.name) {
        case "HeadBucketCommand":
          if (headBucket === "forbidden") throw forbidden()
          if (headBucket === "notfound") throw notFound()
          return {}
        case "PutObjectCommand":
          if (putObject === "forbidden") throw Object.assign(new Error("signature mismatch"), { name: "SignatureDoesNotMatch", $metadata: { httpStatusCode: 403 } })
          objects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, String(cmd.input.Body))
          return {}
        case "GetObjectCommand": {
          const body = objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`)
          if (body === undefined) throw notFound()
          return { Body: { transformToString: async () => body } }
        }
        case "DeleteObjectCommand":
          objects.delete(`${cmd.input.Bucket}/${cmd.input.Key}`)
          return {}
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`)
      }
    },
  } as unknown as S3Client
  return { client, objects, sent }
}

describe("testConnection with an Object Read & Write token (HEAD bucket → 403)", () => {
  it("treats the 403 as a warning and proves both buckets with probe objects", async () => {
    const { client, objects } = fakeClient("forbidden")
    const result = await testConnection(settings, { client })
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]))
    expect(result.ok).toBe(true)
    expect(byName.bucket).toMatchObject({ ok: false, warning: true })
    expect(byName.bucket.detail).toMatch(/Object Read & Write/)
    expect(byName.write.ok).toBe(true)
    expect(byName.read.ok).toBe(true)
    expect(byName.private_bucket).toMatchObject({ ok: true })
    expect(byName.private_bucket.detail).toMatch(/probe OK/)
    expect(byName.delete.ok).toBe(true)
    expect(objects.size).toBe(0) // every probe deleted again
  })
  it("still stops on a 404 (bucket really missing)", async () => {
    const { client, sent } = fakeClient("notfound")
    const result = await testConnection(settings, { client })
    expect(result.ok).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({ name: "bucket", ok: false })
    expect(result.checks[0].warning).toBeUndefined()
    expect(sent).toEqual(["HeadBucketCommand"])
  })
  it("turns the HEAD warning into a hard failure when the write is refused too (wrong secret / scope)", async () => {
    const result = await testConnection(settings, { client: fakeClient("forbidden", "forbidden").client })
    expect(result.ok).toBe(false)
    expect(result.checks[0]).toMatchObject({ name: "bucket", ok: false, warning: false })
    expect(result.checks[0].detail).toMatch(/403.*SignatureDoesNotMatch.*not scoped/)
    expect(result.checks[1]).toMatchObject({ name: "write", ok: false })
    expect(result.checks).toHaveLength(2)
  })
  it("passes cleanly when HEAD bucket is allowed", async () => {
    const result = await testConnection(settings, { client: fakeClient("ok").client })
    expect(result.ok).toBe(true)
    expect(result.checks.every((c) => c.ok)).toBe(true)
  })
})
