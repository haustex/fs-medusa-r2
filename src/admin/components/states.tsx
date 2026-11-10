import { Spinner } from "@medusajs/icons"

export const Loading = () => (
  <div className="flex items-center justify-center p-8">
    <Spinner className="animate-spin text-ui-fg-muted" />
  </div>
)
