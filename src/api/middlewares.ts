import { defineMiddlewares, validateAndTransformBody } from "@medusajs/framework/http"
import { PostAdminR2Cors, PostAdminR2Settings, PostAdminR2TestConnection } from "./admin/r2/validators"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/admin/r2/settings",
      method: "POST",
      middlewares: [validateAndTransformBody(PostAdminR2Settings)],
    },
    {
      matcher: "/admin/r2/test-connection",
      method: "POST",
      middlewares: [validateAndTransformBody(PostAdminR2TestConnection)],
    },
    {
      matcher: "/admin/r2/cors",
      method: "POST",
      middlewares: [validateAndTransformBody(PostAdminR2Cors)],
    },
  ],
})
