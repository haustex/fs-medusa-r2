import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { invalidateR2SettingsCache, R2_SETTINGS_UPDATED_EVENT } from "../lib/settings"

/** Other processes (server / worker) drop their cached settings when the Admin saves. */
export default async function r2SettingsUpdatedHandler({ container }: SubscriberArgs<{ id: string }>) {
  invalidateR2SettingsCache()
  container.resolve(ContainerRegistrationKeys.LOGGER).debug(`[r2] settings cache cleared (pid ${process.pid})`)
}

export const config: SubscriberConfig = {
  event: R2_SETTINGS_UPDATED_EVENT,
}
