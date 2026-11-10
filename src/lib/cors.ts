import { type CORSRule, GetBucketCorsCommand, PutBucketCorsCommand, type S3Client } from "@aws-sdk/client-s3"
import { MedusaError } from "@medusajs/framework/utils"

/**
 * CORS on the bucket matters for one thing only: browser uploads straight to R2
 * through presigned PUT URLs (`getPresignedUploadUrl`). Everything else goes
 * through the Medusa server. R2 ignores AllowedHeaders casing and does not
 * support the `MaxAgeSeconds` + wildcard-origin combination any differently
 * from S3, so a plain S3 rule works.
 */

/** Methods a browser upload needs: PUT (the upload), GET/HEAD (reading back). */
export const CORS_METHODS = ["GET", "HEAD", "PUT"] as const

/** The rule the "Apply CORS" button adds for one origin. */
export function corsRuleFor(origin: string): CORSRule {
  return {
    AllowedOrigins: [origin],
    AllowedMethods: [...CORS_METHODS],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  }
}

/** Same rule as JSON for the Cloudflare dashboard (R2 → bucket → Settings → CORS policy). */
export function corsPolicyJson(origin: string): string {
  const rule = corsRuleFor(origin)
  return JSON.stringify(
    [
      {
        AllowedOrigins: rule.AllowedOrigins,
        AllowedMethods: rule.AllowedMethods,
        AllowedHeaders: rule.AllowedHeaders,
        ExposeHeaders: rule.ExposeHeaders,
        MaxAgeSeconds: rule.MaxAgeSeconds,
      },
    ],
    null,
    2
  )
}

export function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin.trim())
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return u.origin
  } catch {
    return null
  }
}

function originMatches(allowed: string, origin: string): boolean {
  if (allowed === "*" || allowed === origin) return true
  // S3-style single wildcard, e.g. https://*.example.com
  if (allowed.includes("*")) {
    const pattern = new RegExp(`^${allowed.split("*").map(escapeRegExp).join(".*")}$`, "i")
    return pattern.test(origin)
  }
  return false
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type CorsStatus =
  | { state: "allowed"; rules: number }
  | { state: "missing"; rules: number; missingMethods: string[] }
  | { state: "none" }
  | { state: "forbidden"; detail: string }
  | { state: "error"; detail: string }

/** Does the bucket's CORS configuration allow `origin` to PUT/GET/HEAD? */
export async function checkCors(client: S3Client, bucket: string, origin: string): Promise<CorsStatus> {
  let rules: CORSRule[]
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
    rules = res.CORSRules ?? []
  } catch (e) {
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
    const status = err.$metadata?.httpStatusCode
    if (err.name === "NoSuchCORSConfiguration" || status === 404) return { state: "none" }
    if (status === 403 || err.name === "AccessDenied") {
      return { state: "forbidden", detail: "this token cannot read the CORS policy (needs Admin Read & Write)" }
    }
    return { state: "error", detail: `${err.name ?? "Error"}: ${err.message ?? "unknown"}`.slice(0, 200) }
  }
  if (!rules.length) return { state: "none" }

  const allowedMethods = new Set<string>()
  for (const rule of rules) {
    if ((rule.AllowedOrigins ?? []).some((o) => originMatches(o, origin))) {
      for (const m of rule.AllowedMethods ?? []) allowedMethods.add(m.toUpperCase())
    }
  }
  const missingMethods = CORS_METHODS.filter((m) => !allowedMethods.has(m))
  return missingMethods.length
    ? { state: "missing", rules: rules.length, missingMethods }
    : { state: "allowed", rules: rules.length }
}

export type ApplyCorsResult = { rules: number; added: boolean }

/**
 * Adds a rule for `origin` to the bucket's CORS policy, keeping the rules that
 * are already there. Idempotent: an origin that is already fully allowed is
 * left alone. Needs a token with Admin Read & Write on the bucket.
 */
export async function applyCors(client: S3Client, bucket: string, origin: string): Promise<ApplyCorsResult> {
  const status = await checkCors(client, bucket, origin)
  if (status.state === "allowed") return { rules: status.rules, added: false }
  if (status.state === "forbidden" || status.state === "error") {
    throw new MedusaError(status.state === "forbidden" ? MedusaError.Types.NOT_ALLOWED : MedusaError.Types.UNEXPECTED_STATE, status.detail)
  }

  let existing: CORSRule[] = []
  if (status.state !== "none") {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
    existing = res.CORSRules ?? []
  }
  // Drop any rule that is only about this origin, then add the complete one
  const kept = existing.filter((r) => !(r.AllowedOrigins?.length === 1 && r.AllowedOrigins[0] === origin))
  const rules = [...kept, corsRuleFor(origin)]
  await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }))
  return { rules: rules.length, added: true }
}
