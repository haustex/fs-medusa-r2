import path from "node:path"
import { ulid } from "ulid"

/**
 * Sanitizes a file path: posix slashes, no leading slash, no `.`/`..` segments.
 * Mirrors what Medusa's own S3 provider accepts so keys look the same.
 */
export function sanitizeFilePath(filePath: string): string {
  const cleanPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "")
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

/** `${publicUrl}/${key}`; without a public URL the key alone is returned so callers can tell. */
export function publicUrlFor(publicUrl: string | null, key: string): string | null {
  return publicUrl ? `${publicUrl}/${encodeKeyForUrl(key)}` : null
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
