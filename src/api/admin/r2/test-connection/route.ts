import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { testConnection } from "../../../../lib/connection-test"
import { normalizeOrigin } from "../../../../lib/cors"
import { getProviderOptions } from "../../../../lib/plugin-options"
import {
  normalizePrefix,
  normalizePublicUrl,
  r2EndpointFor,
  type R2ProviderOptions,
  type R2Settings,
  resolveR2Settings,
} from "../../../../lib/settings"
import type { PostAdminR2TestConnectionType } from "../validators"

/**
 * Tests the stored settings, with any field typed in the form overriding them
 * for this call only (so credentials can be checked before they are saved).
 * Writes and deletes one probe object; nothing else is touched.
 */
export async function POST(req: AuthenticatedMedusaRequest<PostAdminR2TestConnectionType>, res: MedusaResponse) {
  const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const stored = await resolveR2Settings(pg, (getProviderOptions(req.scope) ?? {}) as R2ProviderOptions, {
    fresh: true,
    logger: req.scope.resolve(ContainerRegistrationKeys.LOGGER),
  })
  const { origin: typedOrigin, ...overrides } = req.validatedBody
  const settings = applyOverrides(stored, overrides)
  const origin = normalizeOrigin(typedOrigin ?? req.get("origin") ?? "")
  res.json(await testConnection(settings, { origin }))
}

/** undefined = field not sent (keep stored); null = sent empty (clear) */
function text(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  const v = value?.trim()
  return v ? v : null
}

/** `override` when the field was sent, else the stored value */
function pick(override: string | null | undefined, stored: string | null): string | null {
  return override === undefined ? stored : override
}

export function applyOverrides(stored: R2Settings, body: PostAdminR2TestConnectionType): R2Settings {
  const accountId = pick(text(body.account_id), stored.accountId)
  const jurisdiction = body.jurisdiction ?? stored.jurisdiction
  const typedEndpoint = text(body.endpoint)
  const customEndpoint =
    typedEndpoint === undefined ? (stored.endpointIsCustom ? stored.endpoint : null) : normalizePublicUrl(typedEndpoint)
  const endpoint = customEndpoint ?? (accountId ? r2EndpointFor(accountId, jurisdiction) : null)

  // Typed credentials replace the stored pair only when both halves are given.
  const typedKey = text(body.access_key_id)
  const typedSecret = text(body.secret_access_key)
  const useTyped = !!typedKey && !!typedSecret
  const accessKeyId = useTyped ? typedKey : stored.accessKeyId
  const secretAccessKey = useTyped ? typedSecret : stored.secretAccessKey

  const bucket = pick(text(body.bucket), stored.bucket)
  const typedPublicUrl = text(body.public_url)
  const publicUrl = typedPublicUrl === undefined ? stored.publicUrl : normalizePublicUrl(typedPublicUrl)
  const prefix = body.prefix === undefined ? stored.prefix : normalizePrefix(body.prefix)
  const privateBucket = pick(text(body.private_bucket), stored.privateBucket)

  const missing: R2Settings["missing"] = []
  if (!endpoint) missing.push("endpoint")
  if (!accessKeyId) missing.push("access_key_id")
  if (!secretAccessKey) missing.push("secret_access_key")
  if (!bucket) missing.push("bucket")

  return {
    ...stored,
    accountId,
    jurisdiction,
    endpoint,
    endpointIsCustom: !!customEndpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicUrl,
    prefix,
    privateBucket,
    missing,
    configured: missing.length === 0,
  }
}
