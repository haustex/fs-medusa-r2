import { S3Client } from "@aws-sdk/client-s3"
import { MedusaError } from "@medusajs/framework/utils"
import type { R2Settings } from "./settings"

/**
 * One S3Client per distinct (endpoint, key, secret). R2 only knows the region
 * "auto". The checksum options keep the SDK from adding CRC32 trailers on
 * every PutObject, which R2 and other S3-compatible stores reject or ignore.
 */
export function createR2Client(settings: Pick<R2Settings, "endpoint" | "accessKeyId" | "secretAccessKey">): S3Client {
  if (!settings.endpoint || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "createR2Client: endpoint and credentials are required")
  }
  return new S3Client({
    region: "auto",
    endpoint: settings.endpoint,
    // Path style keeps MinIO and other S3-compatible stores working; R2 accepts both.
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
}

export function clientCacheKey(settings: Pick<R2Settings, "endpoint" | "accessKeyId" | "secretAccessKey">): string {
  return `${settings.endpoint}\u0000${settings.accessKeyId}\u0000${settings.secretAccessKey}`
}
