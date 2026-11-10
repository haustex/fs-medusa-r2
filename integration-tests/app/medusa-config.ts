import path from "node:path"
import { defineConfig } from "@medusajs/framework/utils"

// Test app for the E2E suite. Only started through scripts/guard.mjs, which on
// the Haus Kayu host allows nothing but the r2-spike-* containers and ports 9600+.
const pluginDir = process.env.R2_PLUGIN_DIR || path.resolve(__dirname, "../..")

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    workerMode: "shared",
    http: {
      storeCors: "*",
      adminCors: "*",
      authCors: "*",
      jwtSecret: "r2-e2e-jwt",
      cookieSecret: "r2-e2e-cookie",
    },
  },
  admin: { disable: process.env.R2_ADMIN !== "1", backendUrl: "/" },
  plugins: [{ resolve: pluginDir, options: { showCredit: true } }],
  modules: [
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: path.join(pluginDir, ".medusa/server/src/providers/r2"),
            id: "r2",
            // Nothing here: the suite configures everything through the Admin API,
            // except one run (R2_E2E_OPTIONS=1) that checks the options fallback.
            options:
              process.env.R2_E2E_OPTIONS === "1"
                ? {
                    endpoint: process.env.R2_E2E_ENDPOINT,
                    access_key_id: process.env.R2_E2E_KEY,
                    secret_access_key: process.env.R2_E2E_SECRET,
                    bucket: process.env.R2_E2E_BUCKET,
                    public_url: process.env.R2_E2E_PUBLIC_URL,
                  }
                : { settings_cache_ttl_ms: 500 },
          },
        ],
      },
    },
  ],
})
