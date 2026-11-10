import { emitEventStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { R2_SETTINGS_UPDATED_EVENT } from "../lib/settings"
import { upsertR2SettingsStep, type UpsertR2SettingsInput } from "./steps/upsert-r2-settings"

export const saveR2SettingsWorkflow = createWorkflow("save-r2-settings", function (input: UpsertR2SettingsInput) {
  const saved = upsertR2SettingsStep(input)
  const eventData = transform({ saved }, ({ saved }) => ({ id: saved.id }))
  emitEventStep({ eventName: R2_SETTINGS_UPDATED_EVENT, data: eventData })
  return new WorkflowResponse(saved)
})
