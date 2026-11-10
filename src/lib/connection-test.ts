import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import { ulid } from "ulid"
import { checkCors } from "./cors"
import { encodeKeyForUrl } from "./file-key"
import { createR2Client } from "./r2-client"
import type { R2Settings } from "./settings"

export type CheckName = "bucket" | "write" | "read" | "public_url" | "private_bucket" | "cors" | "delete"

export type Check = {
  name: CheckName
  ok: boolean
  /** short, never contains credentials */
  detail: string | null
  /** a failed check that does not make the connection unusable (CORS is only needed for browser uploads) */
  warning?: boolean
}

export type ConnectionTestResult = {
  ok: boolean
  latency_ms: number
  endpoint: string | null
  bucket: string | null
  checks: Check[]
}

const PUBLIC_FETCH_TIMEOUT_MS = 8_000

/** 403 for lack of permission; a wrong key or secret is also a 403 but names itself and is a real failure */
function isForbidden(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (err.name === "SignatureDoesNotMatch" || err.name === "InvalidAccessKeyId") return false
  return err.$metadata?.httpStatusCode === 403 || err.name === "AccessDenied" || err.name === "Forbidden"
}

function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const status = err.$metadata?.httpStatusCode
  const name = err.name && err.name !== "Error" ? err.name : null
  const parts = [status ? `HTTP ${status}` : null, name, err.message && err.message !== name ? err.message : null]
  return parts.filter(Boolean).join(": ").slice(0, 300) || "unknown error"
}

const HEAD_FORBIDDEN = "HEAD bucket not permitted for this token (normal for an Object Read & Write token); checked with a probe object instead"

/**
 * Exercises the configured bucket end to end: HEAD bucket, write a probe
 * object, read it back, fetch it through the public URL (when one is set),
 * HEAD the private bucket (when one is set), delete the probe. Each step is
 * reported separately so the Admin can say exactly what is wrong.
 *
 * An R2 token with Object Read & Write only (the recommended least-privilege
 * token) may be refused HEAD bucket with 403. That is a warning, not a
 * failure: the probe object then decides whether the bucket is usable.
 */
export async function testConnection(
  settings: R2Settings,
  {
    fetchImpl = fetch,
    origin = null,
    client: injectedClient,
  }: { fetchImpl?: typeof fetch; origin?: string | null; client?: S3Client } = {}
): Promise<ConnectionTestResult> {
  const started = Date.now()
  const checks: Check[] = []
  const done = (): ConnectionTestResult => ({
    ok: checks.every((c) => c.ok || c.warning),
    latency_ms: Date.now() - started,
    endpoint: settings.endpoint,
    bucket: settings.bucket,
    checks,
  })

  if (!settings.configured) {
    checks.push({ name: "bucket", ok: false, detail: `not configured (missing: ${settings.missing.join(", ")})` })
    return done()
  }

  let client: S3Client
  try {
    client = injectedClient ?? createR2Client(settings)
  } catch (e) {
    checks.push({ name: "bucket", ok: false, detail: describeError(e) })
    return done()
  }
  const bucket = settings.bucket as string

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    checks.push({ name: "bucket", ok: true, detail: null })
  } catch (e) {
    if (!isForbidden(e)) {
      checks.push({ name: "bucket", ok: false, detail: describeError(e) })
      client.destroy()
      return done()
    }
    checks.push({ name: "bucket", ok: false, warning: true, detail: HEAD_FORBIDDEN })
  }

  const key = `${settings.prefix}.medusa-storage-r2/probe-${ulid()}.txt`
  const body = `medusa-storage-r2 connection test ${new Date().toISOString()}`
  try {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain", CacheControl: "no-store" })
    )
    checks.push({ name: "write", ok: true, detail: key })
  } catch (e) {
    const bucketCheck = checks[0]
    if (bucketCheck.warning && (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403) {
      // HEAD and the write both refused: not an object-only token, but wrong credentials or a token
      // that is not scoped to this bucket. HEAD carries no error body, so the write's message is the useful one.
      bucketCheck.ok = false
      bucketCheck.warning = false
      bucketCheck.detail = `${describeError(e)} — HEAD bucket and write both refused: wrong access key/secret, or the token is not scoped to this bucket`
    }
    checks.push({ name: "write", ok: false, detail: describeError(e) })
    client.destroy()
    return done()
  }

  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const text = await res.Body?.transformToString()
    checks.push(text === body ? { name: "read", ok: true, detail: null } : { name: "read", ok: false, detail: "content differs" })
  } catch (e) {
    checks.push({ name: "read", ok: false, detail: describeError(e) })
  }

  if (settings.publicUrl) {
    const url = `${settings.publicUrl}/${encodeKeyForUrl(key)}`
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PUBLIC_FETCH_TIMEOUT_MS)
      const res = await fetchImpl(url, { signal: controller.signal, cache: "no-store" as RequestCache })
      clearTimeout(timer)
      const text = res.ok ? await res.text() : ""
      checks.push(
        res.ok && text === body
          ? { name: "public_url", ok: true, detail: null }
          : { name: "public_url", ok: false, detail: res.ok ? "content differs" : `HTTP ${res.status}` }
      )
    } catch (e) {
      checks.push({ name: "public_url", ok: false, detail: describeError(e) })
    }
  }

  if (settings.privateBucket) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: settings.privateBucket }))
      checks.push({ name: "private_bucket", ok: true, detail: null })
    } catch (e) {
      if (!isForbidden(e)) {
        checks.push({ name: "private_bucket", ok: false, detail: describeError(e) })
      } else {
        // Object-only token: prove the bucket with a probe object instead of HEAD bucket
        const privateKey = `${settings.prefix}.medusa-storage-r2/probe-${ulid()}.txt`
        try {
          await client.send(
            new PutObjectCommand({ Bucket: settings.privateBucket, Key: privateKey, Body: body, ContentType: "text/plain", CacheControl: "no-store" })
          )
          await client.send(new DeleteObjectCommand({ Bucket: settings.privateBucket, Key: privateKey }))
          checks.push({ name: "private_bucket", ok: true, detail: "write/delete probe OK (HEAD bucket not permitted for this token)" })
        } catch (e2) {
          checks.push({ name: "private_bucket", ok: false, detail: describeError(e2) })
        }
      }
    }
  }

  if (origin) {
    const cors = await checkCors(client, bucket, origin)
    switch (cors.state) {
      case "allowed":
        checks.push({ name: "cors", ok: true, detail: `${origin} may upload from the browser` })
        break
      case "none":
        checks.push({ name: "cors", ok: false, warning: true, detail: `no CORS policy; browser uploads from ${origin} would fail` })
        break
      case "missing":
        checks.push({
          name: "cors",
          ok: false,
          warning: true,
          detail: `${origin} is not allowed to ${cors.missingMethods.join("/")} (${cors.rules} rule(s) present)`,
        })
        break
      default:
        checks.push({ name: "cors", ok: false, warning: true, detail: cors.detail })
    }
  }

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    checks.push({ name: "delete", ok: true, detail: null })
  } catch (e) {
    checks.push({ name: "delete", ok: false, detail: describeError(e) })
  }

  client.destroy()
  return done()
}
