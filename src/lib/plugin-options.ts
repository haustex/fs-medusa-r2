import fs from "node:fs"
import path from "node:path"
import type { ConfigModule, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export const PACKAGE_NAME = "medusa-storage-r2"

/** Options of the plugin entry (`plugins: [{ resolve, options }]`), separate from the provider's options */
export type R2PluginOptions = {
  /** Show the small "by Haus Kayu" credit under the plugin's Admin page. Default true. */
  showCredit?: boolean
}

type Entry = string | { resolve?: unknown; options?: unknown }

function packageNameAt(dir: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name ?? null
  } catch {
    return null
  }
}

/** A resolve string that points at this package: its name, a sub-path of it, or a local path to it */
export function isThisPackage(resolve: string): boolean {
  const r = resolve.replace(/\/+$/, "")
  if (r === PACKAGE_NAME || r.startsWith(`${PACKAGE_NAME}/`) || r.includes(`/${PACKAGE_NAME}`)) return true
  if (r.startsWith(".") || path.isAbsolute(r)) {
    for (let dir = path.resolve(r), i = 0; i < 6; i++, dir = path.dirname(dir)) {
      if (packageNameAt(dir) === PACKAGE_NAME) return true
    }
  }
  return false
}

export function getPluginOptions(container: MedusaContainer): R2PluginOptions {
  const config: ConfigModule = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
  for (const p of (config.plugins ?? []) as Entry[]) {
    const resolve = typeof p === "string" ? p : p.resolve
    if (typeof resolve === "string" && isThisPackage(resolve)) {
      return typeof p === "string" ? {} : ((p.options as R2PluginOptions) ?? {})
    }
  }
  return {}
}

type ModuleEntry = { resolve?: unknown; options?: { providers?: unknown }; providers?: unknown }

/**
 * The options of this package's provider entry inside the File Module config,
 * or null when `medusa-config.ts` does not register it (the Admin shows a hint).
 */
export function getProviderOptions(container: MedusaContainer): Record<string, unknown> | null {
  const config: ConfigModule = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
  const modules = config.modules ?? {}
  const entries = (Array.isArray(modules) ? modules : Object.values(modules as Record<string, unknown>)) as ModuleEntry[]
  for (const m of entries) {
    if (!m || typeof m !== "object") continue
    const providers = (m.options?.providers ?? m.providers) as Entry[] | undefined
    if (!Array.isArray(providers)) continue
    for (const p of providers) {
      if (p && typeof p === "object" && typeof p.resolve === "string" && isThisPackage(p.resolve)) {
        return ((p.options as Record<string, unknown>) ?? {})
      }
    }
  }
  return null
}
