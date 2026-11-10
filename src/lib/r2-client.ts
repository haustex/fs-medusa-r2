import { S3Client } from "@aws-sdk/client-s3"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { MedusaError } from "@medusajs/framework/utils"
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type R2Settings,
} from "./settings"

type ClientSettings = Pick<R2Settings, "endpoint" | "accessKeyId" | "secretAccessKey"> &
  Partial<Pick<R2Settings, "maxAttempts" | "connectionTimeoutMs" | "requestTimeoutMs">>

/**
 * One S3Client per distinct (endpoint, key, secret). R2 only knows the region
 * "auto". The checksum options keep the SDK from adding CRC32 trailers on
 * every PutObject, which R2 and other S3-compatible stores reject or ignore.
 * Retries: the SDK's adaptive mode retries throttling (429), 5xx and network
 * errors with backoff and never retries other 4xx; timeouts bound each attempt.
 */
export function createR2Client(settings: ClientSettings): S3Client {
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
    maxAttempts: settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryMode: "adaptive",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: settings.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      requestTimeout: settings.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  })
}

export function clientCacheKey(settings: ClientSettings): string {
  return [settings.endpoint, settings.accessKeyId, settings.secretAccessKey, settings.maxAttempts, settings.connectionTimeoutMs, settings.requestTimeoutMs].join("\u0000")
}
