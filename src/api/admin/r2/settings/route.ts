import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { getPluginOptions, getProviderOptions } from "../../../../lib/plugin-options"
import { toPublicSettings } from "../../../../lib/public-settings"
import { type R2ProviderOptions, resolveR2Settings } from "../../../../lib/settings"
import { saveR2SettingsWorkflow } from "../../../../workflows/save-r2-settings"
import type { PostAdminR2SettingsType } from "../validators"

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
  res.json({ settings: await describeSettings(req) })
}

export async function POST(req: AuthenticatedMedusaRequest<PostAdminR2SettingsType>, res: MedusaResponse) {
  const body = req.validatedBody
  await saveR2SettingsWorkflow(req.scope).run({
    input: {
      ...body,
      // an empty field in the form clears the stored value
      access_key_id: body.access_key_id === "" ? null : body.access_key_id,
      secret_access_key: body.secret_access_key === "" ? null : body.secret_access_key,
    },
  })
  res.json({ settings: await describeSettings(req) })
}
