import { model } from "@medusajs/framework/utils"

/**
 * Who changed what, when: one row per save / credential removal / CORS change.
 * Field names only, never values; secrets are listed as "access_key_id",
 * "secret_access_key" at most.
 */
const R2SettingEvent = model.define("r2_setting_event", {
  id: model.id({ prefix: "r2evt" }).primaryKey(),
  // "settings.saved" | "credentials.removed" | "cors.applied" | "encryption_key.rotated"
  action: model.text(),
  actor_id: model.text().nullable(),
  actor_email: model.text().nullable(),
  // { names: ["bucket", "public_url", "access_key_id", "secret_access_key"] }
  fields: model.json().nullable(),
  // free text without secrets, e.g. the origin a CORS rule was added for
  detail: model.text().nullable(),
})

export default R2SettingEvent
