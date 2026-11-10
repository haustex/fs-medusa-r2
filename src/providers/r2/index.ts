import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import R2FileProviderService from "./service"

export { R2FileProviderService }

export default ModuleProvider(Modules.FILE, {
  services: [R2FileProviderService],
})
