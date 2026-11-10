import { Module } from "@medusajs/framework/utils"
import R2SettingsModuleService from "./service"

export const R2_SETTINGS_MODULE = "r2Settings"

export default Module(R2_SETTINGS_MODULE, {
  service: R2SettingsModuleService,
})
