import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { R2_SETTINGS_MODULE } from "../../modules/r2Settings"
import R2SettingsModuleService from "../../modules/r2Settings/service"

export type LogR2SettingEventInput = {
  action: "settings.saved" | "credentials.removed" | "cors.applied" | "encryption_key.rotated"
  actor?: { id: string | null; email: string | null } | null
  /** field names only, never values */
  fields: string[]
  /** free text without secrets */
  detail?: string | null
}

export const logR2SettingEventStep = createStep(
  "log-r2-setting-event",
  async (input: LogR2SettingEventInput, { container }) => {
    const service: R2SettingsModuleService = container.resolve(R2_SETTINGS_MODULE)
    const event = await service.createR2SettingEvents({
      action: input.action,
      actor_id: input.actor?.id ?? null,
      actor_email: input.actor?.email ?? null,
      fields: { names: input.fields },
      detail: input.detail ?? null,
    })
    return new StepResponse({ id: event.id }, event.id)
  },
  async (id, { container }) => {
    if (!id) return
    const service: R2SettingsModuleService = container.resolve(R2_SETTINGS_MODULE)
    await service.deleteR2SettingEvents(id)
  }
)
