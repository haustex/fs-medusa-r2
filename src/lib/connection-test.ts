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

function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const status = err.$metadata?.httpStatusCode
  const name = err.name && err.name !== "Error" ? err.name : null
  const parts = [status ? `HTTP ${status}` : null, name, err.message && err.message !== name ? err.message : null]
  return parts.filter(Boolean).join(": ").slice(0, 300) || "unknown error"
}

/**
 * Exercises the configured bucket end to end: HEAD bucket, write a probe
 * object, read it back, fetch it through the public URL (when one is set),
 * HEAD the private bucket (when one is set), delete the probe. Each step is
 * reported separately so the Admin can say exactly what is wrong.
 */
export async function testConnection(
  settings: R2Settings,
  { fetchImpl = fetch, origin = null }: { fetchImpl?: typeof fetch; origin?: string | null } = {}
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
    client = createR2Client(settings)
  } catch (e) {
    checks.push({ name: "bucket", ok: false, detail: describeError(e) })
    return done()
  }
  const bucket = settings.bucket as string

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    checks.push({ name: "bucket", ok: true, detail: null })
  } catch (e) {
    checks.push({ name: "bucket", ok: false, detail: describeError(e) })
    client.destroy()
    return done()
  }

  const key = `${settings.prefix}.medusa-storage-r2/probe-${ulid()}.txt`
  const body = `medusa-storage-r2 connection test ${new Date().toISOString()}`
  try {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain", CacheControl: "no-store" })
    )
    checks.push({ name: "write", ok: true, detail: key })
  } catch (e) {
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
      checks.push({ name: "private_bucket", ok: false, detail: describeError(e) })
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
