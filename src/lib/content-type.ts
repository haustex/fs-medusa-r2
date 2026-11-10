/**
 * Content type from the first bytes of a file. The type the client sends is
 * only used when the bytes say nothing (plain text, CSV, unknown binaries):
 * a browser that calls a PNG "application/octet-stream" or a renamed file
 * should not decide what the CDN serves.
 */

type Signature = { mime: string; test: (b: Uint8Array) => boolean }

const ascii = (s: string, offset = 0) => (b: Uint8Array) => {
  if (b.length < offset + s.length) return false
  for (let i = 0; i < s.length; i++) if (b[offset + i] !== s.charCodeAt(i)) return false
  return true
}
const bytes = (sig: number[], offset = 0) => (b: Uint8Array) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v)

const SIGNATURES: Signature[] = [
  { mime: "image/png", test: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/jpeg", test: bytes([0xff, 0xd8, 0xff]) },
  { mime: "image/gif", test: (b) => ascii("GIF87a")(b) || ascii("GIF89a")(b) },
  { mime: "image/webp", test: (b) => ascii("RIFF")(b) && ascii("WEBP", 8)(b) },
  { mime: "image/avif", test: (b) => ascii("ftyp", 4)(b) && (ascii("avif", 8)(b) || ascii("avis", 8)(b)) },
  { mime: "image/heic", test: (b) => ascii("ftyp", 4)(b) && (ascii("heic", 8)(b) || ascii("heix", 8)(b) || ascii("mif1", 8)(b)) },
  { mime: "video/mp4", test: (b) => ascii("ftyp", 4)(b) && (ascii("isom", 8)(b) || ascii("mp42", 8)(b) || ascii("mp41", 8)(b) || ascii("iso2", 8)(b)) },
  { mime: "video/quicktime", test: (b) => ascii("ftyp", 4)(b) && ascii("qt  ", 8)(b) },
  { mime: "video/webm", test: bytes([0x1a, 0x45, 0xdf, 0xa3]) },
  { mime: "image/bmp", test: ascii("BM") },
  { mime: "image/tiff", test: (b) => bytes([0x49, 0x49, 0x2a, 0x00])(b) || bytes([0x4d, 0x4d, 0x00, 0x2a])(b) },
  { mime: "image/x-icon", test: bytes([0x00, 0x00, 0x01, 0x00]) },
  { mime: "application/pdf", test: ascii("%PDF-") },
  { mime: "application/zip", test: (b) => bytes([0x50, 0x4b, 0x03, 0x04])(b) || bytes([0x50, 0x4b, 0x05, 0x06])(b) },
  { mime: "application/gzip", test: bytes([0x1f, 0x8b]) },
  { mime: "font/woff2", test: ascii("wOF2") },
  { mime: "font/woff", test: ascii("wOFF") },
  { mime: "audio/mpeg", test: (b) => ascii("ID3")(b) || bytes([0xff, 0xfb])(b) || bytes([0xff, 0xf3])(b) },
  { mime: "application/ogg", test: ascii("OggS") },
  { mime: "image/svg+xml", test: isSvg },
]

/** Enough bytes for every signature above plus an SVG/XML prologue. */
export const SNIFF_BYTES = 512

function isSvg(b: Uint8Array): boolean {
  // `<svg` or `<?xml … <svg` within the first bytes, after optional BOM/whitespace
  let text = ""
  for (let i = 0; i < Math.min(b.length, SNIFF_BYTES); i++) text += String.fromCharCode(b[i])
  const head = text.replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart()
  return head.startsWith("<svg") || (head.startsWith("<?xml") && /<svg[\s>]/.test(head))
}

/** The MIME type the bytes identify, or null when they do not identify one. */
export function sniffContentType(head: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.test(head))?.mime ?? null
}

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-www-form-urlencoded", "multipart/form-data"])

/**
 * Content type to store: what the bytes say, else what the client said unless
 * that is generic, else a guess from the extension, else octet-stream.
 */
export function resolveContentType(head: Uint8Array, declared: string | undefined, filename: string): string {
  const sniffed = sniffContentType(head)
  const clean = (declared ?? "").split(";")[0].trim().toLowerCase()
  const declaredOk = !!clean && !GENERIC.has(clean) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(clean)
  // A zip container may be a docx/xlsx/epub…: keep the specific declared type
  if (sniffed && !(sniffed === "application/zip" && declaredOk)) return sniffed
  if (declaredOk) return clean
  return byExtension(filename) ?? "application/octet-stream"
}

const EXTENSIONS: Record<string, string> = {
  css: "text/css",
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  xml: "application/xml",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

export function byExtension(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return ext ? (EXTENSIONS[ext] ?? null) : null
}
