import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    // raw body is piped straight into the File Module's upload stream
    { matcher: "/admin/e2e/file", method: "PUT", bodyParser: false, middlewares: [] },
  ],
})
