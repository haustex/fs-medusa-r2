import { MedusaService } from "@medusajs/framework/utils"
import R2Setting from "./models/r2-setting"
import R2SettingEvent from "./models/r2-setting-event"

class R2SettingsModuleService extends MedusaService({
  R2Setting,
  R2SettingEvent,
}) {}

export default R2SettingsModuleService
