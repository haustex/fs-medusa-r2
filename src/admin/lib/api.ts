import { useQuery } from "@tanstack/react-query"
import { sdk } from "./client"
import type { PublicSettings } from "./types"

export const r2Keys = {
  settings: ["r2", "settings"] as const,
}

export function useR2Settings() {
  return useQuery({
    queryKey: r2Keys.settings,
    queryFn: () => sdk.client.fetch<{ settings: PublicSettings }>("/admin/r2/settings"),
  })
}
