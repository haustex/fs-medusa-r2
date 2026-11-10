import { z } from "@medusajs/framework/zod"

const text = z.string().trim().max(500)
const nullableText = text.nullable()
const ttl = z.number().int().min(60).max(604800) // 1 min … 7 days (SigV4 maximum)

export const PostAdminR2Settings = z
  .object({
    account_id: nullableText.optional(),
    jurisdiction: z.enum(["default", "eu", "fedramp"]).optional(),
    endpoint: nullableText.optional(),
    access_key_id: nullableText.optional(),
    secret_access_key: nullableText.optional(),
    bucket: nullableText.optional(),
    public_url: nullableText.optional(),
    public_url_template: nullableText.optional(),
    prefix: nullableText.optional(),
    private_bucket: nullableText.optional(),
    cache_control: nullableText.optional(),
    download_url_ttl: ttl.optional(),
    upload_url_ttl: ttl.optional(),
  })
  .strict()
export type PostAdminR2SettingsType = z.infer<typeof PostAdminR2Settings>

const origin = z.string().trim().url().max(300)

/** Everything optional: fields typed in the form override the stored settings for this test only. */
export const PostAdminR2TestConnection = z
  .object({
    /** Admin origin whose CORS rule is checked (the page sends window.location.origin) */
    origin: origin.optional(),
    account_id: nullableText.optional(),
    jurisdiction: z.enum(["default", "eu", "fedramp"]).optional(),
    endpoint: nullableText.optional(),
    access_key_id: nullableText.optional(),
    secret_access_key: nullableText.optional(),
    bucket: nullableText.optional(),
    public_url: nullableText.optional(),
    prefix: nullableText.optional(),
    private_bucket: nullableText.optional(),
  })
  .strict()
export type PostAdminR2TestConnectionType = z.infer<typeof PostAdminR2TestConnection>

export const PostAdminR2Cors = z
  .object({
    /** Origin to allow for browser uploads (presigned PUT); default: the request's Origin header */
    origin: origin.optional(),
  })
  .strict()
export type PostAdminR2CorsType = z.infer<typeof PostAdminR2Cors>
