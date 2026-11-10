import { MedusaService } from "@medusajs/framework/utils"
import R2Setting from "./models/r2-setting"

class R2SettingsModuleService extends MedusaService({
  R2Setting,
}) {}

export default R2SettingsModuleService
