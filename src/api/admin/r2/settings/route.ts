import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { getPluginOptions, getProviderOptions } from "../../../../lib/plugin-options"
import { toPublicSettings } from "../../../../lib/public-settings"
import { type R2ProviderOptions, resolveR2Settings } from "../../../../lib/settings"
import { R2_SETTINGS_MODULE } from "../../../../modules/r2Settings"
import type R2SettingsModuleService from "../../../../modules/r2Settings/service"
import { saveR2SettingsWorkflow } from "../../../../workflows/save-r2-settings"
import type { PostAdminR2SettingsType } from "../validators"

/** Who is calling: the Admin user's id and e-mail (for the change log) */
export async function actorOf(req: AuthenticatedMedusaRequest): Promise<{ id: string | null; email: string | null }> {
  const id = req.auth_context?.actor_id ?? null
  if (!id) return { id: null, email: null }
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "user", fields: ["id", "email"], filters: { id } })
    return { id, email: data[0]?.email ?? null }
  } catch {
    return { id, email: null }
  }
}

export async function recentEvents(req: AuthenticatedMedusaRequest, take = 20) {
  const service: R2SettingsModuleService = req.scope.resolve(R2_SETTINGS_MODULE)
  const events = await service.listR2SettingEvents({}, { take, order: { created_at: "DESC" } })
  return events.map((e) => ({
    id: e.id,
    action: e.action,
    actor_email: e.actor_email,
    fields: ((e.fields as { names?: string[] } | null)?.names ?? []) as string[],
    detail: e.detail,
    created_at: e.created_at,
  }))
}

export async function describeSettings(req: AuthenticatedMedusaRequest) {
  const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const providerOptions = getProviderOptions(req.scope)
  const settings = await resolveR2Settings(pg, (providerOptions ?? {}) as R2ProviderOptions, {
    fresh: true,
    logger: req.scope.resolve(ContainerRegistrationKeys.LOGGER),
  })
  return toPublicSettings(settings, {
    providerRegistered: providerOptions !== null,
    showCredit: getPluginOptions(req.scope).showCredit !== false,
  })
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.json({ settings: await describeSettings(req), events: await recentEvents(req) })
}

export async function POST(req: AuthenticatedMedusaRequest<PostAdminR2SettingsType>, res: MedusaResponse) {
  const body = req.validatedBody
  await saveR2SettingsWorkflow(req.scope).run({
    input: {
      ...body,
      // an empty field in the form clears the stored value
      access_key_id: body.access_key_id === "" ? null : body.access_key_id,
      secret_access_key: body.secret_access_key === "" ? null : body.secret_access_key,
      actor: await actorOf(req),
    },
  })
  res.json({ settings: await describeSettings(req), events: await recentEvents(req) })
}
