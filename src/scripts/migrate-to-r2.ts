import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { resolveContentType, SNIFF_BYTES } from "../lib/content-type"
import { publicUrlFor, sanitizeFilePath } from "../lib/file-key"
import { getProviderOptions } from "../lib/plugin-options"
import { createR2Client } from "../lib/r2-client"
import { type R2ProviderOptions, type R2Settings, resolveR2Settings } from "../lib/settings"

/**
 * Copies the files behind the URLs stored in the database (product images,
 * thumbnails, …) from the local File Module (static/) or an S3 bucket to R2,
 * verifies each copy, writes a CSV report and rewrites the URLs. Sources are
 * never deleted. Options are plain words (medusa exec rejects --flags):
 *
 *   npx medusa exec ./node_modules/medusa-storage-r2/.medusa/server/src/scripts/migrate-to-r2.js \
 *     source=local static-dir=./static base-url=https://api.example.com/static dry-run
 *
 *   source=local|s3         where the files are now (default local)
 *   static-dir=<dir>        local: the folder the local provider writes to (default ./static)
 *   base-url=<url>          the URL prefix stored in the database for those files (required)
 *   tables=image.url,product.thumbnail,<table>.<column>…   columns to scan and rewrite (default the first two)
 *   report=<dir>            where the CSV report and the state file go (default ./r2-migration)
 *   dry-run                 list and read-check only; no upload, no database change
 *   resume                  skip files the state file marks as copied and verified
 *   rollback                put the old URLs back from the state file (nothing is deleted)
 *   rewrite=no              copy and verify but leave the database alone
 *
 *   source=s3 reads MIGRATE_S3_ENDPOINT, MIGRATE_S3_REGION (default auto), MIGRATE_S3_BUCKET,
 *   MIGRATE_S3_ACCESS_KEY_ID, MIGRATE_S3_SECRET_ACCESS_KEY, MIGRATE_S3_FORCE_PATH_STYLE (1|0)
 *   from the environment; the object key is the URL path after base-url.
 */

type Options = {
  source: "local" | "s3"
  staticDir: string
  baseUrl: string
  tables: { table: string; column: string }[]
  reportDir: string
  dryRun: boolean
  resume: boolean
  rollback: boolean
  rewrite: boolean
}

type Entry = {
  url: string
  key: string
  new_url: string
  size: number | null
  sha256: string | null
  status: "dry-run" | "copied" | "verified" | "rewritten" | "skipped" | "failed" | "rolled-back"
  error: string | null
}

type State = { base_url: string; prefix: string; started_at: string; entries: Record<string, Entry> }

const DEFAULT_TABLES = "image.url,product.thumbnail"

function parseArgs(args: string[]): Options {
  const kv = new Map<string, string>()
  for (const a of args) {
    const i = a.indexOf("=")
    if (i === -1) kv.set(a, "true")
    else kv.set(a.slice(0, i), a.slice(i + 1))
  }
  const source = kv.get("source") ?? "local"
  if (source !== "local" && source !== "s3") throw new MedusaError(MedusaError.Types.INVALID_DATA, "source must be local or s3")
  const baseUrl = (kv.get("base-url") ?? "").replace(/\/+$/, "")
  if (!kv.get("rollback") && !/^https?:\/\//.test(baseUrl)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "base-url=<the URL prefix the stored file URLs start with> is required, e.g. base-url=https://api.example.com/static")
  }
  const tables = (kv.get("tables") ?? DEFAULT_TABLES).split(",").map((t) => {
    const [table, column] = t.trim().split(".")
    if (!table || !column || !/^[a-z0-9_]+$/i.test(table) || !/^[a-z0-9_]+$/i.test(column)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `tables= entries are <table>.<column>, got "${t}"`)
    }
    return { table, column }
  })
  return {
    source,
    staticDir: path.resolve(kv.get("static-dir") ?? "static"),
    baseUrl,
    tables,
    reportDir: path.resolve(kv.get("report") ?? "r2-migration"),
    dryRun: kv.has("dry-run"),
    resume: kv.has("resume"),
    rollback: kv.has("rollback"),
    rewrite: kv.get("rewrite") !== "no",
  }
}

function sourceS3(): { client: S3Client; bucket: string } {
  const env = process.env
  const missing = ["MIGRATE_S3_ENDPOINT", "MIGRATE_S3_BUCKET", "MIGRATE_S3_ACCESS_KEY_ID", "MIGRATE_S3_SECRET_ACCESS_KEY"].filter((k) => !env[k])
  if (missing.length) throw new MedusaError(MedusaError.Types.INVALID_DATA, `source=s3 needs ${missing.join(", ")} in the environment`)
  return {
    bucket: env.MIGRATE_S3_BUCKET as string,
    client: new S3Client({
      region: env.MIGRATE_S3_REGION || "auto",
      endpoint: env.MIGRATE_S3_ENDPOINT,
      forcePathStyle: env.MIGRATE_S3_FORCE_PATH_STYLE !== "0",
      credentials: { accessKeyId: env.MIGRATE_S3_ACCESS_KEY_ID as string, secretAccessKey: env.MIGRATE_S3_SECRET_ACCESS_KEY as string },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  }
}

/** The path of a stored URL below base-url, decoded; null when the URL is not under base-url. */
function relativePath(url: string, baseUrl: string): string | null {
  if (!url.startsWith(`${baseUrl}/`)) return null
  const rest = url.slice(baseUrl.length + 1).split(/[?#]/)[0]
  try {
    return sanitizeFilePath(decodeURIComponent(rest))
  } catch {
    return null
  }
}

type Source = { stream: () => Promise<Readable>; size: number | null }

async function openSource(opts: Options, rel: string, s3?: { client: S3Client; bucket: string }): Promise<Source> {
  if (opts.source === "local") {
    const file = path.join(opts.staticDir, rel)
    if (!file.startsWith(opts.staticDir + path.sep)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "path escapes static-dir")
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) throw new MedusaError(MedusaError.Types.NOT_FOUND, "not a file")
    return { size: stat.size, stream: async () => fs.createReadStream(file) }
  }
  const head = await s3!.client.send(new HeadObjectCommand({ Bucket: s3!.bucket, Key: rel }))
  return {
    size: head.ContentLength ?? null,
    stream: async () => (await s3!.client.send(new GetObjectCommand({ Bucket: s3!.bucket, Key: rel }))).Body as Readable,
  }
}

function csvLine(values: (string | number | null)[]): string {
  return values.map((v) => (v === null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")
}

export default async function migrateToR2({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const opts = parseArgs(args ?? [])
  fs.mkdirSync(opts.reportDir, { recursive: true })
  const statePath = path.join(opts.reportDir, "state.json")
  const reportPath = path.join(opts.reportDir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`)
  const report = fs.createWriteStream(reportPath)
  report.write(`${csvLine(["url", "key", "new_url", "size", "sha256", "status", "error"])}\n`)
  const record = (e: Entry) => report.write(`${csvLine([e.url, e.key, e.new_url, e.size, e.sha256, e.status, e.error])}\n`)

  if (opts.rollback) {
    if (!fs.existsSync(statePath)) throw new MedusaError(MedusaError.Types.NOT_FOUND, `No state file at ${statePath}; nothing to roll back`)
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as State
    let n = 0
    for (const e of Object.values(state.entries)) {
      if (e.status !== "rewritten") continue
      for (const { table, column } of opts.tables) {
        n += await pg(table).where(column, e.new_url).update({ [column]: e.url })
      }
      e.status = "rolled-back"
      record(e)
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    report.end()
    logger.info(`medusa-storage-r2 migrate: rolled back ${n} row(s) to the old URLs. R2 objects and source files were left in place. Report: ${reportPath}`)
    return
  }

  const settings: R2Settings = await resolveR2Settings(pg, (getProviderOptions(container) ?? {}) as R2ProviderOptions, { fresh: true, logger })
  if (!settings.configured) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `Cloudflare R2 is not configured (missing: ${settings.missing.join(", ")}). Save the settings in the Admin first.`)
  }
  if (!settings.publicUrl) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Set the public URL of the bucket in Settings → Cloudflare R2 first; the migrated URLs are built from it.")
  }
  const src = opts.source === "s3" ? sourceS3() : undefined
  const r2 = createR2Client(settings)

  // Collect the URLs under base-url from every table.column
  const urls = new Set<string>()
  for (const { table, column } of opts.tables) {
    const rows: { u: string }[] = await pg(table).distinct(`${column} as u`).whereNotNull(column).where(column, "like", `${opts.baseUrl}/%`)
    for (const row of rows) urls.add(row.u)
    logger.info(`medusa-storage-r2 migrate: ${rows.length} URL(s) under ${opts.baseUrl} in ${table}.${column}`)
  }

  const state: State =
    opts.resume && fs.existsSync(statePath)
      ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as State)
      : { base_url: opts.baseUrl, prefix: settings.prefix, started_at: new Date().toISOString(), entries: {} }
  const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2))

  const counts = { copied: 0, rewritten: 0, skipped: 0, failed: 0, dryRun: 0, bytes: 0 }
  for (const url of urls) {
    const rel = relativePath(url, opts.baseUrl)
    if (!rel) {
      const e: Entry = { url, key: "", new_url: "", size: null, sha256: null, status: "failed", error: "URL is not a file path under base-url" }
      record(e)
      counts.failed++
      continue
    }
    const key = `${settings.prefix}${rel}`
    const newUrl = publicUrlFor(settings.publicUrl, key, settings.publicUrlTemplate) as string
    const previous = state.entries[url]
    if (opts.resume && previous && (previous.status === "verified" || previous.status === "rewritten")) {
      counts.skipped++
      record({ ...previous, status: "skipped" })
      continue
    }
    const entry: Entry = { url, key, new_url: newUrl, size: null, sha256: null, status: "failed", error: null }
    try {
      const source = await openSource(opts, rel, src)
      entry.size = source.size
      if (opts.dryRun) {
        entry.status = "dry-run"
        counts.dryRun++
        counts.bytes += source.size ?? 0
        record(entry)
        continue
      }

      // Stream source → R2 while hashing; the first bytes decide the content type.
      const sha256 = crypto.createHash("sha256")
      const md5 = crypto.createHash("md5")
      let total = 0
      const hashing = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          sha256.update(chunk)
          md5.update(chunk)
          total += chunk.length
          cb(null, chunk)
        },
      })
      const input = await source.stream()
      // Peek the first chunk for the content type before the multipart upload starts
      const first = await new Promise<Buffer>((resolve, reject) => {
        // read() without a size returns what is buffered; read(n) would return null for files shorter than n
        input.once("readable", () => resolve((input.read() as Buffer | null) ?? Buffer.alloc(0)))
        input.once("error", reject)
        input.once("end", () => resolve(Buffer.alloc(0)))
      })
      const body = Readable.from(
        (async function* () {
          if (first.length) yield first
          for await (const chunk of input) yield chunk as Buffer
        })()
      ).pipe(hashing)
      const upload = new Upload({
        client: r2,
        params: {
          Bucket: settings.bucket as string,
          Key: key,
          Body: body,
          ContentType: resolveContentType(first.subarray(0, SNIFF_BYTES), undefined, rel),
          CacheControl: settings.cacheControl,
          Metadata: { "migrated-from": encodeURIComponent(url) },
        },
      })
      const result = await upload.done()
      entry.sha256 = sha256.digest("hex")
      entry.size = total
      entry.status = "copied"
      counts.copied++
      counts.bytes += total

      // Verify: size on R2, and the MD5 when the ETag is a plain MD5 (single-part upload)
      const verify = await r2.send(new HeadObjectCommand({ Bucket: settings.bucket as string, Key: key }))
      if (verify.ContentLength !== total) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `size on R2 ${verify.ContentLength} ≠ ${total}`)
      if (source.size !== null && source.size !== total) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `read ${total} bytes, source reports ${source.size}`)
      const etag = (result.ETag ?? verify.ETag ?? "").replace(/"/g, "")
      if (etag && !etag.includes("-") && etag !== md5.digest("hex")) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "MD5 of the copy differs from the source")
      entry.status = "verified"

      if (opts.rewrite) {
        for (const { table, column } of opts.tables) {
          await pg(table).where(column, url).update({ [column]: newUrl })
        }
        entry.status = "rewritten"
        counts.rewritten++
      }
    } catch (e) {
      entry.status = "failed"
      entry.error = ((e as Error).message ?? String(e)).slice(0, 300)
      counts.failed++
      logger.warn(`medusa-storage-r2 migrate: ${url} → ${entry.error}`)
    }
    state.entries[url] = entry
    record(entry)
    saveState()
  }
  report.end()
  r2.destroy()
  src?.client.destroy()

  const mb = (counts.bytes / 1024 / 1024).toFixed(1)
  if (opts.dryRun) {
    logger.info(`medusa-storage-r2 migrate (dry run): ${counts.dryRun} file(s), ${mb} MB would be copied to ${settings.bucket}/${settings.prefix}; ${counts.failed} unreadable. Report: ${reportPath}`)
  } else {
    logger.info(`medusa-storage-r2 migrate: ${counts.copied} copied + verified (${mb} MB), ${counts.rewritten} URL(s) rewritten, ${counts.skipped} skipped (resume), ${counts.failed} failed. Nothing was deleted. Report: ${reportPath}; state: ${statePath}`)
    if (counts.failed) logger.warn("medusa-storage-r2 migrate: fix the failed rows and run again with resume")
  }
}
