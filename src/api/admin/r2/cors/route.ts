import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { applyCors, corsPolicyJson, normalizeOrigin } from "../../../../lib/cors"
import { getProviderOptions } from "../../../../lib/plugin-options"
import { createR2Client } from "../../../../lib/r2-client"
import { type R2ProviderOptions, resolveR2Settings } from "../../../../lib/settings"
import { logR2SettingEventWorkflow } from "../../../../workflows/log-r2-setting-event"
import { actorOf, recentEvents } from "../settings/route"
import type { PostAdminR2CorsType } from "../validators"

/**
 * Adds a CORS rule for the Admin's origin (or the one in the body) to the
 * public bucket, so presigned browser uploads work. Existing rules are kept.
 * Needs an R2 token with Admin Read & Write; with an Object Read & Write
 * token the call fails and the response carries the JSON to paste by hand.
 */
export async function POST(req: AuthenticatedMedusaRequest<PostAdminR2CorsType>, res: MedusaResponse) {
  const origin = normalizeOrigin(req.validatedBody.origin ?? req.get("origin") ?? "")
  if (!origin) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Send the origin to allow, e.g. https://admin.example.com")
  }

  const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const settings = await resolveR2Settings(pg, (getProviderOptions(req.scope) ?? {}) as R2ProviderOptions, {
    fresh: true,
    logger: req.scope.resolve(ContainerRegistrationKeys.LOGGER),
  })
  if (!settings.configured) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Cloudflare R2 is not configured yet (missing: ${settings.missing.join(", ")}). Save the settings first.`
    )
  }

  const client = createR2Client(settings)
  try {
    const result = await applyCors(client, settings.bucket as string, origin)
    if (result.added) {
      await logR2SettingEventWorkflow(req.scope).run({
        input: { action: "cors.applied", actor: await actorOf(req), fields: ["cors"], detail: `${origin} on bucket ${settings.bucket}` },
      })
    }
    res.json({ ok: true, origin, bucket: settings.bucket, ...result, events: await recentEvents(req) })
  } catch (e) {
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
    const forbidden = err.$metadata?.httpStatusCode === 403 || err.name === "AccessDenied" || /Admin Read/.test(err.message ?? "")
    // 200 with ok:false so the Admin gets the policy JSON (the JS SDK keeps only `message` of error responses)
    res.json({
      ok: false,
      status: forbidden ? "forbidden" : "error",
      origin,
      bucket: settings.bucket,
      message: forbidden
        ? "This R2 token cannot change the bucket's CORS policy (it needs Admin Read & Write). Paste the policy below in Cloudflare → R2 → bucket → Settings → CORS policy instead."
        : `Could not update the CORS policy: ${(err.message ?? "unknown error").slice(0, 200)}`,
      policy_json: corsPolicyJson(origin),
    })
  } finally {
    client.destroy()
  }
}
