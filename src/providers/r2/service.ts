import { PassThrough, Readable } from "node:stream"
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { Knex } from "@medusajs/framework/mikro-orm/knex"
import type { Logger } from "@medusajs/framework/types"
import type {
  FileTypes,
  ProviderDeleteFileDTO,
  ProviderFileResultDTO,
  ProviderGetFileDTO,
  ProviderGetPresignedUploadUrlDTO,
  ProviderUploadFileDTO,
} from "@medusajs/framework/types"
import { AbstractFileProviderService, ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { buildObjectKey, buildPresignedKey, decodeFileContent, publicUrlFor } from "../../lib/file-key"
import { clientCacheKey, createR2Client } from "../../lib/r2-client"
import { isJurisdiction, type R2ProviderOptions, type R2Settings, resolveR2Settings } from "../../lib/settings"

type InjectedDependencies = {
  logger: Logger
  [ContainerRegistrationKeys.PG_CONNECTION]?: Knex
}

export const NOT_CONFIGURED_HINT = "Open Settings → Cloudflare R2 in the Medusa Admin (or set the R2_* environment variables)."

/**
 * File Module provider for Cloudflare R2 (and any S3-compatible store through a
 * custom endpoint). Registered as `fs_r2_<id>`, e.g. `fs_r2_r2`.
 *
 * Configuration is read on every call (cached for a minute) from the Admin's
 * `r2_setting` table, then the provider options, then the environment, so the
 * store can be pointed at a bucket, or at new credentials, without a restart.
 */
export default class R2FileProviderService extends AbstractFileProviderService {
  static identifier = "r2"

  protected readonly logger_: Logger
  protected readonly options_: R2ProviderOptions
  protected readonly pg_: Knex | undefined
  protected client_: { key: string; client: S3Client } | null = null
  protected warnedNotConfigured_ = false

  static validateOptions(options: Record<string, unknown>): void {
    if (options.jurisdiction !== undefined && !isJurisdiction(options.jurisdiction)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-storage-r2: jurisdiction must be "default", "eu" or "fedramp", got ${JSON.stringify(options.jurisdiction)}`
      )
    }
    for (const field of ["download_url_ttl", "upload_url_ttl", "settings_cache_ttl_ms"] as const) {
      const v = options[field]
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-storage-r2: ${field} must be a positive number`)
      }
    }
  }

  constructor(container: InjectedDependencies, options: R2ProviderOptions = {}) {
    super()
    this.logger_ = container.logger
    this.options_ = options
    // The File Module's container forwards the shared connection; resolving it
    // lazily-by-property keeps the provider usable when it is absent.
    try {
      this.pg_ = container[ContainerRegistrationKeys.PG_CONNECTION]
    } catch {
      this.pg_ = undefined
    }
  }

  /** Current settings; throws a clear error when the store cannot be reached yet. */
  protected async settings(): Promise<R2Settings & { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string }> {
    const s = await resolveR2Settings(this.pg_, this.options_, { logger: this.logger_ })
    if (!s.configured) {
      if (!this.warnedNotConfigured_) {
        this.warnedNotConfigured_ = true
        this.logger_.warn(`[r2] Cloudflare R2 is not configured yet (missing: ${s.missing.join(", ")}). ${NOT_CONFIGURED_HINT}`)
      }
      const reason = s.adminUnavailable ? s.encryption.message : `missing: ${s.missing.join(", ")}`
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Cloudflare R2 is not configured (${reason}). ${NOT_CONFIGURED_HINT}`
      )
    }
    return s as R2Settings & { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string }
  }

  protected client(settings: R2Settings): S3Client {
    const key = clientCacheKey(settings)
    if (!this.client_ || this.client_.key !== key) {
      this.client_?.client.destroy()
      this.client_ = { key, client: createR2Client(settings) }
    }
    return this.client_.client
  }

  protected bucketFor(settings: R2Settings, access: FileTypes.FileAccessPermission | undefined): string {
    return access === "private" && settings.privateBucket ? settings.privateBucket : (settings.bucket as string)
  }

  /** Public files need a public URL; private ones get a presigned link (TTL `download_url_ttl`). */
  protected async urlFor(
    settings: R2Settings,
    client: S3Client,
    bucket: string,
    key: string,
    access: FileTypes.FileAccessPermission | undefined
  ): Promise<string> {
    if (access !== "private") {
      const url = publicUrlFor(settings.publicUrl, key)
      if (url) {
        return url
      }
      this.logger_.warn(
        "[r2] No public URL is set, so this public file only gets a temporary presigned link. Set the public URL (r2.dev or a custom domain) in Settings → Cloudflare R2."
      )
    }
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: settings.downloadUrlTtl })
  }

  async upload(file: ProviderUploadFileDTO): Promise<ProviderFileResultDTO> {
    if (!file?.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No filename provided")
    }
    const settings = await this.settings()
    const key = buildObjectKey(settings.prefix, file.filename)
    if (!key) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid filename: ${file.filename}`)
    }
    const client = this.client(settings)
    const bucket = this.bucketFor(settings, file.access)
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: decodeFileContent(file.content, file.mimeType),
        ContentType: file.mimeType,
        CacheControl: settings.cacheControl,
        Metadata: { "original-filename": encodeURIComponent(file.filename) },
      })
    )
    return { key, url: await this.urlFor(settings, client, bucket, key, file.access) }
  }

  async getUploadStream(fileData: FileTypes.ProviderUploadStreamDTO) {
    if (!fileData?.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No filename provided")
    }
    const settings = await this.settings()
    const key = buildObjectKey(settings.prefix, fileData.filename)
    if (!key) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid filename: ${fileData.filename}`)
    }
    const client = this.client(settings)
    const bucket = this.bucketFor(settings, fileData.access)
    const pass = new PassThrough()
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: pass,
        ContentType: fileData.mimeType,
        CacheControl: settings.cacheControl,
        Metadata: { "original-filename": encodeURIComponent(fileData.filename) },
      },
    })
    const url = await this.urlFor(settings, client, bucket, key, fileData.access)
    return {
      writeStream: pass,
      promise: upload.done().then(() => ({ url, key })),
      url,
      fileKey: key,
    }
  }

  async delete(files: ProviderDeleteFileDTO | ProviderDeleteFileDTO[]): Promise<void> {
    const settings = await this.settings()
    const client = this.client(settings)
    const list = Array.isArray(files) ? files : [files]
    const keys = list.map((f) => f.fileKey).filter((k): k is string => !!k)
    if (!keys.length) {
      return
    }
    // The key alone does not say which bucket holds it; deleting a missing key is a no-op.
    const buckets = settings.privateBucket ? [settings.bucket, settings.privateBucket] : [settings.bucket]
    for (const bucket of buckets) {
      try {
        if (keys.length === 1) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keys[0] }))
        } else {
          await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })
          )
        }
      } catch (e) {
        // A failed delete leaves an orphan object, never a broken store.
        this.logger_.error(`[r2] delete failed in bucket ${bucket}: ${(e as Error).message}`)
      }
    }
  }

  /** Bucket that holds `key`: the private bucket when configured and it has the object, else the public one. */
  protected async locate(settings: R2Settings, client: S3Client, key: string): Promise<string> {
    if (settings.privateBucket) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: settings.privateBucket, Key: key }))
        return settings.privateBucket
      } catch {
        // not there: fall through to the public bucket
      }
    }
    return settings.bucket as string
  }

  async getPresignedDownloadUrl(fileData: ProviderGetFileDTO): Promise<string> {
    if (!fileData?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No fileKey provided")
    }
    const settings = await this.settings()
    const client = this.client(settings)
    const bucket = await this.locate(settings, client, fileData.fileKey)
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: fileData.fileKey }), {
      expiresIn: settings.downloadUrlTtl,
    })
  }

  async getPresignedUploadUrl(fileData: ProviderGetPresignedUploadUrlDTO): Promise<ProviderFileResultDTO> {
    if (!fileData?.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No filename provided")
    }
    const settings = await this.settings()
    const key = buildPresignedKey(settings.prefix, fileData.filename)
    if (!key) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid filename: ${fileData.filename}`)
    }
    const client = this.client(settings)
    const bucket = this.bucketFor(settings, fileData.access)
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: fileData.mimeType }),
      { expiresIn: fileData.expiresIn ?? settings.uploadUrlTtl }
    )
    return { url, key }
  }

  async getDownloadStream(fileData: ProviderGetFileDTO): Promise<Readable> {
    if (!fileData?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No fileKey provided")
    }
    const settings = await this.settings()
    const client = this.client(settings)
    const bucket = await this.locate(settings, client, fileData.fileKey)
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fileData.fileKey }))
    return response.Body as Readable
  }

  async getAsBuffer(fileData: ProviderGetFileDTO): Promise<Buffer> {
    if (!fileData?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No fileKey provided")
    }
    const settings = await this.settings()
    const client = this.client(settings)
    const bucket = await this.locate(settings, client, fileData.fileKey)
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fileData.fileKey }))
    if (!response.Body) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `File ${fileData.fileKey} has no content`)
    }
    return Buffer.from(await response.Body.transformToByteArray())
  }
}
