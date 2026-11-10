import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { decryptSecret, encryptSecret, loadEncryptionKey } from "../lib/crypto"
import { invalidateR2SettingsCache } from "../lib/settings"
import { R2_SETTINGS_MODULE } from "../modules/r2Settings"
import type R2SettingsModuleService from "../modules/r2Settings/service"
import { logR2SettingEventWorkflow } from "../workflows/log-r2-setting-event"

/**
 * Re-encrypts the stored R2 credentials with a new R2_ENCRYPTION_KEY.
 *
 *   R2_ENCRYPTION_KEY_OLD=<old 64 hex> R2_ENCRYPTION_KEY=<new 64 hex> \
 *     npx medusa exec ./node_modules/medusa-storage-r2/.medusa/server/src/scripts/rotate-encryption-key.js
 *
 * Then restart every Medusa process (server and worker) with the new key only.
 * Nothing is printed except the key fingerprints; the credentials never leave
 * the database in clear text.
 */
export default async function rotateEncryptionKey({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const oldKey = loadEncryptionKey(process.env.R2_ENCRYPTION_KEY_OLD)
  const newKey = loadEncryptionKey(process.env.R2_ENCRYPTION_KEY)
  if (oldKey.status !== "ok") {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "R2_ENCRYPTION_KEY_OLD is missing or not 64 hex characters: set it to the key the credentials were saved with.")
  }
  if (newKey.status !== "ok") {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "R2_ENCRYPTION_KEY is missing or not 64 hex characters: set it to the new key (openssl rand -hex 32).")
  }
  if (oldKey.fingerprint === newKey.fingerprint) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "R2_ENCRYPTION_KEY_OLD and R2_ENCRYPTION_KEY are the same key; nothing to rotate.")
  }

  const service: R2SettingsModuleService = container.resolve(R2_SETTINGS_MODULE)
  const [row] = await service.listR2Settings({}, { take: 1, order: { updated_at: "DESC" } })
  if (!row?.access_key_id_encrypted || !row.secret_access_key_encrypted) {
    logger.info("medusa-storage-r2: no credentials stored in the Admin; nothing to rotate.")
    return
  }
  if (row.encryption_key_fingerprint && row.encryption_key_fingerprint !== oldKey.fingerprint) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 
      `The stored credentials were encrypted with key ${row.encryption_key_fingerprint}, not with R2_ENCRYPTION_KEY_OLD (${oldKey.fingerprint}).`
    )
  }

  const accessKeyId = decryptSecret(row.access_key_id_encrypted, oldKey.key, "access_key_id")
  const secretAccessKey = decryptSecret(row.secret_access_key_encrypted, oldKey.key, "secret_access_key")
  await service.updateR2Settings({
    id: row.id,
    access_key_id_encrypted: encryptSecret(accessKeyId, newKey.key, "access_key_id"),
    secret_access_key_encrypted: encryptSecret(secretAccessKey, newKey.key, "secret_access_key"),
    encryption_key_fingerprint: newKey.fingerprint,
  })
  await logR2SettingEventWorkflow(container).run({
    input: {
      action: "encryption_key.rotated",
      fields: ["access_key_id", "secret_access_key", "encryption_key_fingerprint"],
      detail: `key ${oldKey.fingerprint} → ${newKey.fingerprint} (medusa exec)`,
    },
  })
  invalidateR2SettingsCache()
  logger.info(
    `medusa-storage-r2: credentials re-encrypted with key ${newKey.fingerprint} (was ${oldKey.fingerprint}). Restart server and worker with the new R2_ENCRYPTION_KEY.`
  )
}
