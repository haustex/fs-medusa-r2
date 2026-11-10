import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { type LogR2SettingEventInput, logR2SettingEventStep } from "./steps/log-r2-setting-event"

/** Appends one row to the settings change log (names of fields only, never values). */
export const logR2SettingEventWorkflow = createWorkflow("log-r2-setting-event", function (input: LogR2SettingEventInput) {
  return new WorkflowResponse(logR2SettingEventStep(input))
})
