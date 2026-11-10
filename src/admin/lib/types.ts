export type Jurisdiction = "default" | "eu" | "fedramp"

export type PublicSettings = {
  source: "admin" | "options" | "env" | "none"
  configured: boolean
  missing: ("endpoint" | "access_key_id" | "secret_access_key" | "bucket")[]
  account_id: string | null
  jurisdiction: Jurisdiction
  endpoint: string | null
  endpoint_is_custom: boolean
  has_credentials: boolean
  access_key_id_hint: string | null
  bucket: string | null
  public_url: string | null
  prefix: string
  private_bucket: string | null
  cache_control: string
  download_url_ttl: number
  upload_url_ttl: number
  credentials_saved_at: string | null
  encryption: { status: "ok" | "unused" | "missing" | "malformed" | "mismatch"; message: string | null; key_present: boolean }
  provider_registered: boolean
  show_credit: boolean
}

export type CheckName = "bucket" | "write" | "read" | "public_url" | "private_bucket" | "delete"

export type ConnectionTestResult = {
  ok: boolean
  latency_ms: number
  endpoint: string | null
  bucket: string | null
  checks: { name: CheckName; ok: boolean; detail: string | null }[]
}
