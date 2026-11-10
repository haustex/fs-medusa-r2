import { useQuery } from "@tanstack/react-query"
import { sdk } from "./client"
import type { SettingsResponse } from "./types"

export const r2Keys = {
  settings: ["r2", "settings"] as const,
}

export function useR2Settings() {
  return useQuery({
    queryKey: r2Keys.settings,
    queryFn: () => sdk.client.fetch<SettingsResponse>("/admin/r2/settings"),
  })
}
