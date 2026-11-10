import path from "node:path"
import { ulid } from "ulid"

/**
 * Multipart file names reach Medusa decoded as latin1 (busboy's default), so a
 * browser's UTF-8 name "日本.png" arrives as "æ\x97¥æ\x9c¬.png". When every char
 * fits in one byte and those bytes are valid UTF-8, re-decode them; a genuine
 * latin1 name ("café") is not valid UTF-8 and is left alone.
 */
export function repairFilename(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name
  const decoded = Buffer.from(name, "latin1").toString("utf8")
  return decoded.includes("\ufffd") ? name : decoded
}

/**
 * Sanitizes a file path: posix slashes, no leading slash, no `.`/`..` segments.
 * Mirrors what Medusa's own S3 provider accepts so keys look the same.
 */
export function sanitizeFilePath(filePath: string): string {
  const cleanPath = repairFilename(filePath).replace(/\\/g, "/").replace(/^\/+/, "")
  return path.posix
    .normalize(cleanPath)
    .split("/")
    .filter((segment) => segment && segment !== ".." && segment !== ".")
    .join("/")
}

/**
 * Object key for an upload: `<prefix><dir/><name>-<ulid><ext>`. The ULID makes
 * the key unique and unguessable, so a public bucket never serves a file by
 * guessing its original name.
 */
export function buildObjectKey(prefix: string, filename: string, id: string = ulid()): string | null {
  const sanitized = sanitizeFilePath(filename)
  if (!sanitized) {
    return null
  }
  const parsed = path.posix.parse(sanitized)
  return `${prefix}${parsed.dir ? `${parsed.dir}/` : ""}${parsed.name}-${id}${parsed.ext}`
}

/** Key for a presigned upload: the sanitized filename under the prefix, exactly as the caller named it. */
export function buildPresignedKey(prefix: string, filename: string): string | null {
  const sanitized = sanitizeFilePath(filename)
  return sanitized ? `${prefix}${sanitized}` : null
}

export function encodeKeyForUrl(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/")
}

/**
 * Public URL of a key: `${publicUrl}/${key}`, or the template with `{public_url}`
 * and `{key}` filled in (e.g. Cloudflare image transforms:
 * `{public_url}/cdn-cgi/image/format=auto,quality=85/{key}`). Null without a public URL.
 */
export function publicUrlFor(publicUrl: string | null, key: string, template: string | null = null): string | null {
  if (!publicUrl) return null
  const encoded = encodeKeyForUrl(key)
  if (template && template.includes("{key}")) {
    return template.replace(/\{public_url\}/g, publicUrl).replace(/\{key\}/g, encoded)
  }
  return `${publicUrl}/${encoded}`
}

/**
 * Decodes the string `content` of an uploaded file into a Buffer. Upload inputs
 * arrive as a string that may be base64, UTF-8 text (a CSV with accents) or a
 * binary/latin1 string (an image via `buffer.toString("binary")`, as Medusa's
 * upload docs instruct). The encoding is chosen from the MIME type, defaulting
 * to binary for non-text content.
 */
export function decodeFileContent(content: string, mimeType?: string): Buffer {
  const decodedBase64 = Buffer.from(content, "base64")
  if (decodedBase64.toString("base64") === content) {
    return decodedBase64
  }
  const isText =
    mimeType?.startsWith("text/") || mimeType?.includes("csv") || mimeType?.includes("json") || mimeType?.includes("xml")
  return isText ? Buffer.from(content, "utf8") : Buffer.from(content, "binary")
}
