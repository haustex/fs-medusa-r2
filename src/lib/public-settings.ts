import { loadEncryptionKey } from "./crypto"
import type { R2Settings } from "./settings"

/** What the Admin may see: no secrets, hints only. */
export type PublicSettings = {
  source: R2Settings["source"]
  configured: boolean
  missing: R2Settings["missing"]
  account_id: string | null
  jurisdiction: R2Settings["jurisdiction"]
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
  encryption: { status: R2Settings["encryption"]["status"]; message: string | null; key_present: boolean }
  /** false when medusa-config.ts has no File Module provider pointing at this package */
  provider_registered: boolean
  show_credit: boolean
}

export function toPublicSettings(
  s: R2Settings,
  { providerRegistered, showCredit }: { providerRegistered: boolean; showCredit: boolean }
): PublicSettings {
  return {
    source: s.source,
    configured: s.configured,
    missing: s.missing,
    account_id: s.accountId,
    jurisdiction: s.jurisdiction,
    endpoint: s.endpoint,
    endpoint_is_custom: s.endpointIsCustom,
    has_credentials: !!s.accessKeyId && !!s.secretAccessKey,
    access_key_id_hint: s.accessKeyIdHint,
    bucket: s.bucket,
    public_url: s.publicUrl,
    prefix: s.prefix,
    private_bucket: s.privateBucket,
    cache_control: s.cacheControl,
    download_url_ttl: s.downloadUrlTtl,
    upload_url_ttl: s.uploadUrlTtl,
    credentials_saved_at: s.credentialsSavedAt?.toISOString() ?? null,
    encryption: { ...s.encryption, key_present: loadEncryptionKey().status === "ok" },
    provider_registered: providerRegistered,
    show_credit: showCredit,
  }
}
