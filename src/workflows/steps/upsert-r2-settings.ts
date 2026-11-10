import { MedusaError } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { encryptSecret, loadEncryptionKey } from "../../lib/crypto"
import {
  accessKeyIdHint,
  invalidateR2SettingsCache,
  isJurisdiction,
  type Jurisdiction,
  normalizePrefix,
  normalizePublicUrl,
} from "../../lib/settings"
import { R2_SETTINGS_MODULE } from "../../modules/r2Settings"
import R2SettingsModuleService from "../../modules/r2Settings/service"

export type UpsertR2SettingsInput = {
  /** undefined keeps the stored value, null / "" removes it */
  account_id?: string | null
  jurisdiction?: Jurisdiction
  endpoint?: string | null
  /** undefined keeps the stored credentials, null removes both; both halves are saved together */
  access_key_id?: string | null
  secret_access_key?: string | null
  bucket?: string | null
  public_url?: string | null
  /** undefined keeps, null / "" removes; must contain {key} */
  public_url_template?: string | null
  prefix?: string | null
  private_bucket?: string | null
  cache_control?: string | null
  download_url_ttl?: number
  upload_url_ttl?: number
  /** Who saves (for the change log); values are never logged */
  actor?: { id: string | null; email: string | null }
}

type StoredSetting = Awaited<ReturnType<R2SettingsModuleService["listR2Settings"]>>[number]

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i

function textOrNull(value: string | null | undefined): string | null {
  const v = value?.trim()
  return v ? v : null
}

export const upsertR2SettingsStep = createStep(
  "upsert-r2-settings",
  async (input: UpsertR2SettingsInput, { container }) => {
    const service: R2SettingsModuleService = container.resolve(R2_SETTINGS_MODULE)
    const [current] = await service.listR2Settings({}, { take: 1, order: { updated_at: "DESC" } })

    const data: Record<string, unknown> = {}
    if (input.account_id !== undefined) {
      const id = textOrNull(input.account_id)
      if (id && !ACCOUNT_ID_PATTERN.test(id)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "The Cloudflare account ID is 32 hexadecimal characters.")
      }
      data.account_id = id?.toLowerCase() ?? null
    }
    if (input.jurisdiction !== undefined) {
      if (!isJurisdiction(input.jurisdiction)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Jurisdiction must be "default", "eu" or "fedramp".')
      }
      data.jurisdiction = input.jurisdiction
    }
    if (input.endpoint !== undefined) {
      const endpoint = normalizePublicUrl(input.endpoint)
      if (endpoint && !/^https?:\/\/\S+$/i.test(endpoint)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "The endpoint must be an http(s) URL.")
      }
      data.endpoint = endpoint
    }
    if (input.bucket !== undefined) data.bucket = textOrNull(input.bucket)
    if (input.private_bucket !== undefined) data.private_bucket = textOrNull(input.private_bucket)
    if (input.public_url !== undefined) {
      const url = normalizePublicUrl(input.public_url)
      if (url && !/^https?:\/\/\S+$/i.test(url)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "The public URL must be an http(s) URL, e.g. https://pub-xxxx.r2.dev")
      }
      data.public_url = url
    }
    if (input.public_url_template !== undefined) {
      const t = textOrNull(input.public_url_template)
      if (t && !t.includes("{key}")) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "The public URL template must contain {key}, e.g. {public_url}/cdn-cgi/image/format=auto/{key}")
      }
      data.public_url_template = t
    }
    if (input.prefix !== undefined) data.prefix = normalizePrefix(input.prefix)
    if (input.cache_control !== undefined) data.cache_control = textOrNull(input.cache_control) ?? "public, max-age=31536000, immutable"
    if (input.download_url_ttl !== undefined) data.download_url_ttl = input.download_url_ttl
    if (input.upload_url_ttl !== undefined) data.upload_url_ttl = input.upload_url_ttl

    const writesCredentials = !!input.access_key_id || !!input.secret_access_key
    if (writesCredentials) {
      if (!input.access_key_id || !input.secret_access_key) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Enter the access key ID and the secret access key together; they are saved as one pair."
        )
      }
      const key = loadEncryptionKey()
      if (key.status !== "ok") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "R2_ENCRYPTION_KEY is missing or not 64 hex characters (openssl rand -hex 32). The credentials were not saved."
        )
      }
      data.encryption_key_fingerprint = key.fingerprint
      data.access_key_id_encrypted = encryptSecret(input.access_key_id.trim(), key.key, "access_key_id")
      data.access_key_id_hint = accessKeyIdHint(input.access_key_id.trim())
      data.secret_access_key_encrypted = encryptSecret(input.secret_access_key.trim(), key.key, "secret_access_key")
      if (!current?.credentials_saved_at) {
        data.credentials_saved_at = new Date()
      }
    } else if (input.access_key_id === null || input.secret_access_key === null) {
      data.access_key_id_encrypted = null
      data.access_key_id_hint = null
      data.secret_access_key_encrypted = null
      data.encryption_key_fingerprint = null
    }

    const saved = current
      ? await service.updateR2Settings({ id: current.id, ...data })
      : await service.createR2Settings(data)

    // Change log: field names only. Credentials appear as the two field names.
    const fields = Object.keys(data).filter((k) => !/_encrypted$|_hint$|fingerprint|credentials_saved_at/.test(k))
    if (writesCredentials) fields.push("access_key_id", "secret_access_key")
    const removedCredentials = !writesCredentials && (input.access_key_id === null || input.secret_access_key === null)
    if (fields.length || removedCredentials) {
      await service.createR2SettingEvents({
        action: removedCredentials ? "credentials.removed" : "settings.saved",
        actor_id: input.actor?.id ?? null,
        actor_email: input.actor?.email ?? null,
        fields: { names: removedCredentials ? ["access_key_id", "secret_access_key", ...fields] : fields },
        detail: null,
      })
    }

    invalidateR2SettingsCache()
    return new StepResponse({ id: saved.id }, { previous: current ?? null, id: saved.id })
  },
  async (compensation, { container }) => {
    if (!compensation) {
      return
    }
    const service: R2SettingsModuleService = container.resolve(R2_SETTINGS_MODULE)
    const { previous, id } = compensation as { previous: StoredSetting | null; id: string }
    if (previous) {
      const { created_at, updated_at, deleted_at, ...restore } = previous
      void created_at
      void updated_at
      void deleted_at
      await service.updateR2Settings(restore)
    } else {
      await service.deleteR2Settings(id)
    }
    invalidateR2SettingsCache()
  }
)
