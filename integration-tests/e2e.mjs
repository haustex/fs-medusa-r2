// End-to-end check of the provider inside a real Medusa app (integration-tests/app) against MinIO, an
// S3-compatible store that behaves like R2 for everything the provider does: fresh database, migrations,
// server on port 9600, then the Admin API (settings, connection test, uploads, presigned URLs, deletes).
//
// Usage (plugin built first with `npm run build`):
//   docker run -d --name r2-spike-pg -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=r2_spike -p 127.0.0.1:55435:5432 postgres:17-alpine
//   docker run -d --name r2-spike-minio -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
//     -p 127.0.0.1:59000:9000 minio/minio server /data
//   node integration-tests/e2e.mjs
//
// R2_PG_CONTAINER: name of the Postgres container (default r2-spike-pg). The script waits up to 60 s for it over
// TCP (a fresh postgres image first runs a temporary, socket-only server for its init scripts and restarts).
// R2_E2E_S3: MinIO endpoint (default http://127.0.0.1:59000), R2_E2E_S3_KEY / R2_E2E_S3_SECRET (default minioadmin).
//
// R2_E2E_LIVE=1: the object store is a real Cloudflare R2 bucket instead of MinIO/RustFS (Postgres and the Medusa app
// stay local). Needs R2_LIVE_ACCOUNT_ID, R2_LIVE_ACCESS_KEY_ID, R2_LIVE_SECRET_ACCESS_KEY, R2_LIVE_BUCKET (public access
// on, r2.dev URL in R2_LIVE_PUBLIC_URL); optional R2_LIVE_PRIVATE_BUCKET, R2_LIVE_JURISDICTION. Every key of the run
// sits under a unique prefix that is deleted at the end; bucket CORS is only changed when the token may do so.
//
// Every medusa command goes through scripts/guard.mjs (r2-spike-* containers and ports 9600+ only).
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, "..")
const APP_DIR = path.join(HERE, "app")
const STATE_DIR = path.join(HERE, ".state")
const GUARD = path.join(PLUGIN_DIR, "scripts/guard.mjs")
const MEDUSA = path.join(PLUGIN_DIR, "node_modules/.bin/medusa")
const require = createRequire(path.join(PLUGIN_DIR, "package.json"))
const {
  S3Client,
  CreateBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  DeleteBucketCorsCommand,
} = require("@aws-sdk/client-s3")

const DB_NAME = "r2_e2e"
const PG_CONTAINER = process.env.R2_PG_CONTAINER || "r2-spike-pg"
const PG_WAIT_S = 60
const PORT = 9600
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN = { email: "admin@e2e.test", password: "e2e-password-123" }
const ENCRYPTION_KEY = "0123456789abcdef".repeat(4)

const LIVE = process.env.R2_E2E_LIVE === "1"
const S3 = LIVE
  ? {
      accountId: process.env.R2_LIVE_ACCOUNT_ID || "",
      jurisdiction: process.env.R2_LIVE_JURISDICTION || "default",
      endpoint: "",
      key: process.env.R2_LIVE_ACCESS_KEY_ID || "",
      secret: process.env.R2_LIVE_SECRET_ACCESS_KEY || "",
      bucket: process.env.R2_LIVE_BUCKET || "",
      privateBucket: process.env.R2_LIVE_PRIVATE_BUCKET || null,
      publicUrl: (process.env.R2_LIVE_PUBLIC_URL || "").replace(/\/+$/, ""),
    }
  : {
      endpoint: process.env.R2_E2E_S3 || "http://127.0.0.1:59000",
      key: process.env.R2_E2E_S3_KEY || "minioadmin",
      secret: process.env.R2_E2E_S3_SECRET || "minioadmin",
      bucket: "r2-e2e-public",
      privateBucket: "r2-e2e-private",
    }
if (LIVE) {
  const missing = ["accountId", "key", "secret", "bucket", "publicUrl"].filter((k) => !S3[k])
  if (missing.length) throw new Error(`R2_E2E_LIVE=1 needs: ${missing.join(", ")} (R2_LIVE_* variables)`)
  const host = S3.jurisdiction === "default" ? "" : `${S3.jurisdiction}.`
  S3.endpoint = `https://${S3.accountId.toLowerCase()}.${host}r2.cloudflarestorage.com`
} else {
  // MinIO serves anonymous reads of a bucket with a public policy at <endpoint>/<bucket>: the stand-in for r2.dev
  S3.publicUrl = `${S3.endpoint}/${S3.bucket}`
}
// Live runs keep every key under a unique prefix so parallel runs never collide and cleanup is one listing.
const P = LIVE ? `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}/` : ""

const OPTIONS_RUN = process.env.R2_E2E_OPTIONS === "1"

const env = {
  ...process.env,
  DATABASE_URL: `postgres://postgres:spike@127.0.0.1:55435/${DB_NAME}`,
  REDIS_URL: "redis://127.0.0.1:56382",
  PORT: String(PORT),
  R2_PLUGIN_DIR: PLUGIN_DIR,
  R2_ADMIN: process.env.R2_ADMIN ?? "",
  R2_ENCRYPTION_KEY: ENCRYPTION_KEY,
  NODE_ENV: "development",
  ...(OPTIONS_RUN
    ? {
        R2_E2E_OPTIONS: "1",
        R2_E2E_ENDPOINT: S3.endpoint,
        R2_E2E_KEY: S3.key,
        R2_E2E_SECRET: S3.secret,
        R2_E2E_BUCKET: S3.bucket,
        R2_E2E_PUBLIC_URL: S3.publicUrl,
      }
    : {}),
}
// REDIS_URL only satisfies the guard; the test app uses the in-memory event bus and workflow engine

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: APP_DIR, env, stdio: "inherit", ...opts })
  if (r.status !== 0) throw new Error(`failed: ${cmd} ${args.join(" ")}`)
}
const guarded = (...args) => run("node", [GUARD, MEDUSA, ...args])

function linkNodeModules() {
  const target = path.join(APP_DIR, "node_modules")
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(path.join(PLUGIN_DIR, "node_modules"))) {
    if ([".package-lock.json", ".cache", ".vite", ".bin"].includes(entry)) continue
    fs.symlinkSync(path.join(PLUGIN_DIR, "node_modules", entry), path.join(target, entry))
  }
  fs.symlinkSync(PLUGIN_DIR, path.join(target, "medusa-storage-r2"))
}

/** Runs SQL; with a database name, returns the unaligned result instead of streaming it to the console. */
function psql(sql, db) {
  if (!db) {
    run("docker", ["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
    return ""
  }
  const out = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tAc", sql], { encoding: "utf8" })
  if (out.status !== 0) throw new Error(`psql failed: ${out.stderr}`)
  return out.stdout
}

async function waitForPostgres() {
  const started = Date.now()
  let last = ""
  while (Date.now() - started < PG_WAIT_S * 1000) {
    const ready = spawnSync("docker", ["exec", PG_CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { encoding: "utf8" })
    if (ready.status === 0) {
      const q = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-tAc", "select 1"], { encoding: "utf8" })
      if (q.status === 0 && q.stdout.trim() === "1") return
      last = (q.stderr || q.stdout).trim()
    } else last = (ready.stderr || ready.stdout).trim()
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Postgres container "${PG_CONTAINER}" not ready after ${PG_WAIT_S} s (last: ${last || "no answer"}).`)
}

const s3 = new S3Client({
  region: "auto",
  endpoint: S3.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: S3.key, secretAccessKey: S3.secret },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
})

async function prepareBuckets() {
  if (LIVE) {
    await s3.send(new ListObjectsV2Command({ Bucket: S3.bucket, MaxKeys: 1 }))
    return
  }
  for (let i = 0; ; i++) {
    try {
      await s3.send(new ListObjectsV2Command({ Bucket: "nonexistent-probe", MaxKeys: 1 })).catch((e) => {
        if (e?.name !== "NoSuchBucket") throw e
      })
      break
    } catch (e) {
      if (i > 30) throw new Error(`MinIO not reachable at ${S3.endpoint}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  for (const Bucket of [S3.bucket, S3.privateBucket]) {
    await s3.send(new CreateBucketCommand({ Bucket })).catch((e) => {
      if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(e?.name)) throw e
    })
    const list = await s3.send(new ListObjectsV2Command({ Bucket }))
    if (list.Contents?.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: list.Contents.map(({ Key }) => ({ Key })), Quiet: true } }))
    }
    // the CORS checks start from a bucket without a policy
    await s3.send(new DeleteBucketCorsCommand({ Bucket })).catch(() => undefined)
  }
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: S3.bucket,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { AWS: ["*"] }, Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${S3.bucket}/*`] }],
      }),
    })
  )
}

/** Live runs: remove everything this run wrote (keys under the run prefix) in both buckets. */
async function cleanupLive() {
  if (!LIVE) return
  for (const Bucket of [S3.bucket, S3.privateBucket].filter(Boolean)) {
    for (;;) {
      const list = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: P }))
      if (!list.Contents?.length) break
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: list.Contents.map(({ Key }) => ({ Key })), Quiet: true } }))
      if (!list.IsTruncated) break
    }
  }
}

async function objectExists(Bucket, Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }))
    return true
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return false
    throw e
  }
}

let failures = 0
let passes = 0
function check(name, ok, detail) {
  if (ok) passes++
  else failures++
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok || detail === undefined ? "" : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`)
}

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/")

/** raw: a FormData, or { body: Buffer, type, chunked } (chunked = streamed without content-length) */
async function api(method, url, { body, headers = {}, raw } = {}) {
  let sendHeaders = raw ? headers : { "content-type": "application/json", ...headers }
  let sendBody = raw ?? (body ? JSON.stringify(body) : undefined)
  let duplex
  if (raw && !(raw instanceof FormData)) {
    sendHeaders = { ...headers, "content-type": raw.type }
    if (raw.chunked) {
      sendBody = Readable.toWeb(Readable.from([raw.body]))
      duplex = "half"
    } else {
      sendBody = raw.body
    }
  }
  const res = await fetch(BASE + url, { method, headers: sendHeaders, body: sendBody, duplex })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, headers: res.headers }
}

async function main() {
  if (!fs.existsSync(path.join(PLUGIN_DIR, ".medusa/server/src/providers/r2/index.js"))) {
    throw new Error("Build the plugin first: npm run build")
  }
  fs.mkdirSync(STATE_DIR, { recursive: true })
  linkNodeModules()
  await waitForPostgres()
  await prepareBuckets()
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  psql(`CREATE DATABASE ${DB_NAME}`)
  guarded("db:migrate")
  guarded("user", "-e", ADMIN.email, "-p", ADMIN.password)

  let serverDir = APP_DIR
  if (process.env.R2_ADMIN === "1") {
    guarded("build")
    serverDir = path.join(APP_DIR, ".medusa/server")
    fs.rmSync(path.join(serverDir, "node_modules"), { recursive: true, force: true })
    fs.symlinkSync(path.join(APP_DIR, "node_modules"), path.join(serverDir, "node_modules"))
  }
  const log = fs.openSync(path.join(STATE_DIR, "server.log"), "w")
  const server = spawn("node", [GUARD, MEDUSA, "start"], { cwd: serverDir, env, stdio: ["ignore", log, log], detached: true })
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break
      } catch {}
      if (i > 120) throw new Error("server did not start, see integration-tests/.state/server.log")
      await new Promise((r) => setTimeout(r, 1000))
    }
    try {
      if (OPTIONS_RUN) await optionsChecks()
      else await checks()
    } finally {
      await cleanupLive().catch((e) => console.error("cleanup failed:", e.message))
    }
    if (process.env.R2_KEEP === "1") {
      fs.writeFileSync(path.join(STATE_DIR, "server.pid"), String(server.pid))
      console.log(`\nserver kept running on ${BASE} (pid ${server.pid}); stop with: kill -- -${server.pid}`)
      console.log(`\n${passes} passed, ${failures} failed`)
      process.exit(failures ? 1 : 0)
    }
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM")
    } catch {}
  }
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

async function login() {
  const auth = await api("POST", "/auth/user/emailpass", { body: ADMIN })
  if (!auth.json?.token) throw new Error(`login failed: ${JSON.stringify(auth.json)}`)
  return { authorization: `Bearer ${auth.json.token}` }
}

function multipart(files) {
  const form = new FormData()
  for (const f of files) form.append("files", new Blob([f.content], { type: f.type }), f.name)
  return form
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

async function checks() {
  const admin = await login()
  const s = () => api("GET", "/admin/r2/settings", { headers: admin })

  console.log("\nBefore configuration")
  let r = await api("GET", "/admin/r2/settings")
  check("settings need a login", r.status === 401, r.status)
  r = await s()
  check("GET settings: not configured, provider registered, nothing missing is hidden", r.status === 200 && r.json.settings.configured === false && r.json.settings.provider_registered === true && r.json.settings.missing.length === 4 && r.json.settings.encryption.key_present === true, r.json)
  check("GET settings exposes no secret fields", !JSON.stringify(r.json).includes("encrypted") && !JSON.stringify(r.json).includes("secretAccessKey"), r.json)

  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "a.png", type: "image/png", content: PNG }]) })
  check("upload before configuration fails with a clear message", r.status === 400 && /not configured/.test(r.json.message) && /Settings/.test(r.json.message), r.json)

  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: {} })
  check("test connection without settings reports what is missing", r.status === 200 && r.json.ok === false && /missing/.test(r.json.checks[0].detail), r.json)

  console.log("\nConnection test with typed values (nothing saved yet)")
  r = await api("POST", "/admin/r2/test-connection", {
    headers: admin,
    body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: S3.secret, bucket: S3.bucket, public_url: S3.publicUrl, private_bucket: S3.privateBucket, prefix: `${P}medusa` },
  })
  const names = (r.json.checks ?? []).map((c) => `${c.name}:${c.ok}`)
  check("all checks pass incl. public URL and private bucket", r.status === 200 && r.json.ok === true && names.join(",") === `bucket:true,write:true,read:true,public_url:true,${S3.privateBucket ? "private_bucket:true," : ""}delete:true`, r.json)
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: "wrong", bucket: S3.bucket } })
  check("wrong secret → bucket check fails with HTTP 403", r.json.ok === false && r.json.checks[0].name === "bucket" && /403|Forbidden|SignatureDoesNotMatch/.test(r.json.checks[0].detail), r.json)
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: S3.secret, bucket: "does-not-exist-" + Date.now() } })
  // R2 answers 403 AccessDenied for a bucket outside the token's scope (the least-privilege setup); 404 for a root key
  check(LIVE ? "missing bucket → bucket check fails with HTTP 403/404" : "missing bucket → bucket check fails with HTTP 404", r.json.ok === false && r.json.checks[0].name === "bucket" && (LIVE ? /403|AccessDenied|404|NotFound|NoSuchBucket/ : /404|NotFound|NoSuchBucket/).test(r.json.checks[0].detail), r.json)
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: S3.secret, bucket: S3.bucket, public_url: `${S3.publicUrl}/does-not-serve-this`, prefix: `${P}medusa` } })
  check("public URL that does not serve the bucket → only public_url fails", r.json.ok === false && r.json.checks.filter((c) => !c.ok).map((c) => c.name).join() === "public_url", r.json)
  check("the probe object was deleted again", !(await s3.send(new ListObjectsV2Command({ Bucket: S3.bucket, Prefix: P || undefined }))).KeyCount)

  console.log("\nSave settings")
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { access_key_id: S3.key } })
  check("key without secret is refused", r.status === 400 && /together/.test(r.json.message), r.json)
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { account_id: "nothex" } })
  check("bad account id is refused", r.status === 400, r.json)
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { public_url: "ftp://x" } })
  check("non-http public URL is refused", r.status === 400, r.json)
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { download_url_ttl: 5 } })
  check("ttl below 60 s is refused by validation", r.status === 400, r.json)
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { unknown_field: 1 } })
  check("unknown fields are refused", r.status === 400, r.json)

  r = await api("POST", "/admin/r2/settings", {
    headers: admin,
    body: {
      ...(LIVE ? { account_id: S3.accountId.toUpperCase(), jurisdiction: S3.jurisdiction } : { endpoint: S3.endpoint }),
      access_key_id: S3.key,
      secret_access_key: S3.secret,
      bucket: S3.bucket,
      public_url: `${S3.publicUrl}/`,
      prefix: `/${P}medusa/`,
      cache_control: "public, max-age=600",
      download_url_ttl: 120,
    },
  })
  const st = r.json.settings
  check("settings saved: configured, source admin, hint masked, values normalized", r.status === 200 && st.configured === true && st.source === "admin" && st.has_credentials === true && st.access_key_id_hint === "••••" && st.public_url === S3.publicUrl && st.prefix === `${P}medusa/` && st.endpoint === S3.endpoint && st.endpoint_is_custom === !LIVE && st.download_url_ttl === 120 && st.encryption.status === "ok" && st.credentials_saved_at, st)
  check("saved settings response never contains the secret", !JSON.stringify(r.json).includes(S3.secret) && !JSON.stringify(r.json).includes("encrypted"), r.json)
  const row = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", DB_NAME, "-tAc", "select access_key_id_encrypted, secret_access_key_encrypted from r2_setting"], { encoding: "utf8" }).stdout
  check("credentials are stored encrypted (v1.<iv>.<tag>.<ct>), never in clear", /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\|v1\./.test(row.trim()) && !row.includes(S3.secret), row.trim().slice(0, 80))

  console.log("\nUploads through the Admin API (no restart)")
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "talenan jati.png", type: "image/png", content: PNG }]) })
  const up = r.json.files?.[0]
  check("upload succeeds and returns the public URL", r.status === 200 && up && up.url.startsWith(`${S3.publicUrl}/${encodeKey(P)}medusa/talenan%20jati-`) && up.url.endsWith(".png") && up.id.startsWith(`${P}medusa/talenan jati-`), r.json)
  let res = await fetch(up.url)
  check("the public URL serves the exact bytes with the Cache-Control header", res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(PNG) && res.headers.get("cache-control") === "public, max-age=600" && res.headers.get("content-type") === "image/png", { status: res.status, cc: res.headers.get("cache-control") })
  check("object lives in the public bucket", await objectExists(S3.bucket, up.id))

  r = await api("GET", `/admin/uploads/${encodeURIComponent(up.id)}`, { headers: admin })
  check("GET /admin/uploads/:id returns a presigned URL that works", r.status === 200 && /X-Amz-Signature/.test(r.json.file.url) && (await fetch(r.json.file.url)).status === 200, r.json)

  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "a.png", type: "image/png", content: PNG }, { name: "b.csv", type: "text/csv", content: Buffer.from("nama,harga\nTalenan,150000") }]) })
  const [a, b] = r.json.files ?? []
  check("multi-file upload keeps text content intact", r.status === 200 && a && b && (await (await fetch(b.url)).text()) === "nama,harga\nTalenan,150000", r.json)

  r = await api("DELETE", `/admin/uploads/${encodeURIComponent(up.id)}`, { headers: admin })
  check("DELETE /admin/uploads/:id removes the object", r.status === 200 && !(await objectExists(S3.bucket, up.id)), r.json)

  console.log("\nContent type, file names, streams")
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "mislabeled.bin", type: "application/octet-stream", content: PNG }]) })
  let headRes = await s3.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: r.json.files[0].id }))
  check("content type comes from the bytes, not the client (PNG sent as octet-stream)", r.status === 200 && headRes.ContentType === "image/png", headRes.ContentType)
  const odd = "Talenan Jati #1 – ukuran 30×20 (tes) ñ 日本.png"
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: odd, type: "image/png", content: PNG }]) })
  const oddFile = r.json.files?.[0]
  res = oddFile ? await fetch(oddFile.url) : null
  check("unicode / space / # file names round-trip through the key and the public URL", r.status === 200 && oddFile.id.startsWith(`${P}medusa/Talenan Jati #1 – ukuran 30×20 (tes) ñ 日本-`) && res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(PNG) && (await objectExists(S3.bucket, oddFile.id)), { id: oddFile?.id, url: oddFile?.url, status: res?.status })

  const big = Buffer.alloc(12 * 1024 * 1024)
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i)
  PNG.copy(big, 0)
  r = await api("PUT", `/admin/e2e/file?filename=${encodeURIComponent("video/big stream.bin")}&mimeType=application/octet-stream`, { headers: admin, raw: { body: big, type: "application/octet-stream", chunked: true } })
  const bigKey = r.json.fileKey
  headRes = bigKey ? await s3.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: bigKey })) : null
  check("12 MB stream upload without content-length completes as multipart (size + sniffed type)", r.status === 200 && headRes?.ContentLength === big.length && headRes?.ContentType === "image/png", { status: r.status, len: headRes?.ContentLength, type: headRes?.ContentType, body: r.json })
  res = bigKey ? await fetch(`${S3.publicUrl}/${encodeKey(bigKey)}`) : null
  check("…and the public URL serves it byte for byte", res?.status === 200 && Buffer.from(await res.arrayBuffer()).equals(big), res?.status)
  r = await api("PUT", `/admin/e2e/file?filename=small.txt&mimeType=text/plain`, { headers: admin, raw: { body: Buffer.from("tiny"), type: "application/octet-stream", chunked: true } })
  check("stream upload smaller than the sniff window still completes", r.status === 200 && (await (await fetch(r.json.file.url)).text()) === "tiny", r.json)
  r = await api("PUT", `/admin/e2e/file?filename=empty.txt&mimeType=text/plain`, { headers: admin, raw: { body: Buffer.alloc(0), type: "application/octet-stream", chunked: true } })
  check("empty stream upload completes", r.status === 200 && (await s3.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: r.json.fileKey }))).ContentLength === 0, r.json)

  console.log("\nPrivate files")
  r = await api("POST", "/admin/e2e/file", { headers: admin, body: { filename: "exports/products.csv", content: Buffer.from("id,title\n1,A").toString("base64"), mimeType: "text/csv", access: "private" } })
  check("private file without a private bucket is REJECTED (never written to the public bucket)", r.status === 400 && /private bucket/i.test(r.json.message) && /never written to the public bucket/.test(r.json.message), r.json)
  check("…and nothing landed in the public bucket", !(await s3.send(new ListObjectsV2Command({ Bucket: S3.bucket, Prefix: `${P}medusa/exports/` }))).KeyCount)
  r = await api("PUT", `/admin/e2e/file?filename=${encodeURIComponent("exports/stream.csv")}&mimeType=text/csv&access=private`, { headers: admin, raw: { body: Buffer.from("a,b"), type: "application/octet-stream" } })
  check("private stream upload without a private bucket is rejected too", r.status === 400 && /private bucket/i.test(r.json.message), r.json)

  if (!S3.privateBucket) console.log("  - private bucket checks skipped (R2_LIVE_PRIVATE_BUCKET not set)")
  if (S3.privateBucket) {
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { private_bucket: S3.privateBucket } })
  check("private bucket saved", r.status === 200 && r.json.settings.private_bucket === S3.privateBucket, r.json)
  r = await api("POST", "/admin/e2e/file", { headers: admin, body: { filename: "exports/products.csv", content: Buffer.from("id,title\n1,A").toString("base64"), mimeType: "text/csv", access: "private" } })
  const priv = r.json.file
  check("private file lands in the private bucket with a presigned URL", r.status === 200 && priv.id.startsWith(`${P}medusa/exports/products-`) && /X-Amz-Signature/.test(priv.url) && (await objectExists(S3.privateBucket, priv.id)) && !(await objectExists(S3.bucket, priv.id)), r.json)
  const privHead = await s3.send(new HeadObjectCommand({ Bucket: S3.privateBucket, Key: priv.id }))
  check("private objects are stored with Cache-Control: private, no-store", privHead.CacheControl === "private, no-store", privHead.CacheControl)
  r = await api("GET", `/admin/e2e/file?key=${encodeURIComponent(priv.id)}`, { headers: admin })
  check("getAsBuffer and retrieveFile locate it in the private bucket", r.status === 200 && r.json.content === "id,title\n1,A" && /X-Amz-Signature/.test(r.json.url) && (await fetch(r.json.url)).status === 200, r.json)
  r = await api("DELETE", `/admin/e2e/file?key=${encodeURIComponent(priv.id)}`, { headers: admin })
  check("delete removes it from the private bucket", r.status === 200 && !(await objectExists(S3.privateBucket, priv.id)), r.json)
  }
  r = await api("POST", "/admin/e2e/file", { headers: admin, body: { filename: "public.txt", content: Buffer.from("hello").toString("base64"), mimeType: "text/plain", access: "public" } })
  check("public files still go to the public bucket", r.status === 200 && (await objectExists(S3.bucket, r.json.file.id)) && (await (await fetch(r.json.file.url)).text()) === "hello", r.json)

  console.log("\nPresigned uploads")
  r = await api("POST", "/admin/uploads/presigned-urls", { headers: admin, body: { originalname: "photo.png", mime_type: "image/png", size: PNG.length, access: "public" } })
  check("presigned upload URL issued under the prefix", r.status === 200 && /X-Amz-Signature/.test(r.json.url) && r.json.filename.startsWith(`${P}medusa/`) && r.json.filename.endsWith(".png"), r.json)
  res = await fetch(r.json.url, { method: "PUT", body: PNG, headers: { "content-type": "image/png" } })
  check("PUT to the presigned URL stores the object", res.status === 200 && (await objectExists(S3.bucket, r.json.filename)), res.status)
  res = await fetch(`${S3.publicUrl}/${r.json.filename}`)
  check("…which is served from the public URL", res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(PNG), res.status)

  console.log("\nCORS")
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { origin: "https://admin.example.test" } })
  let corsCheck = r.json.checks?.find((c) => c.name === "cors")
  const corsOrigin = `https://admin-${P.replace(/\W/g, "") || "e2e"}.example.test`
  check("test connection reports the CORS state as a warning at most, overall still OK", r.status === 200 && r.json.ok === true && corsCheck && (corsCheck.ok === true || corsCheck.warning === true), r.json)
  r = await api("POST", "/admin/r2/cors", { headers: admin, body: { origin: `${corsOrigin}/app/settings` } })
  let corsApplied = false
  if (LIVE && r.json.ok === false) {
    check("Apply CORS with a token without Admin rights returns the policy to paste by hand", r.status === 200 && r.json.status === "forbidden" && /Admin Read & Write/.test(r.json.message) && JSON.parse(r.json.policy_json)[0].AllowedOrigins[0] === corsOrigin, r.json)
  } else {
    corsApplied = true
    check("Apply CORS adds a rule for the origin", r.status === 200 && r.json.ok === true && r.json.added === true && r.json.origin === corsOrigin && r.json.rules >= 1, r.json)
    const corsCfg = await s3.send(new GetBucketCorsCommand({ Bucket: S3.bucket }))
    const rule = corsCfg.CORSRules?.find((c) => c.AllowedOrigins?.[0] === corsOrigin)
    check("bucket CORS policy contains the origin with GET/HEAD/PUT", !!rule && ["GET", "HEAD", "PUT"].every((m) => rule.AllowedMethods.includes(m)), corsCfg.CORSRules)
    r = await api("POST", "/admin/r2/cors", { headers: admin, body: { origin: corsOrigin } })
    check("Apply CORS is idempotent", r.status === 200 && r.json.ok === true && r.json.added === false, r.json)
    const before = r.json.rules
    r = await api("POST", "/admin/r2/cors", { headers: admin, body: { origin: `${corsOrigin.replace("https://", "https://second-")}` } })
    check("a second origin is appended, the first is kept", r.status === 200 && r.json.added === true && r.json.rules === before + 1, r.json)
    r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { origin: corsOrigin } })
    corsCheck = r.json.checks?.find((c) => c.name === "cors")
    check("test connection now passes the CORS check", corsCheck?.ok === true, r.json)
  }
  r = await api("POST", "/admin/r2/cors", { headers: admin, body: { origin: "ftp://nope" } })
  check("bad origin is refused", r.status === 400, r.json)

  console.log("\nChange log and URL template")
  r = await api("GET", "/admin/r2/settings", { headers: admin })
  const ev = r.json.events ?? []
  check("GET settings returns the change log, newest first, with the actor's e-mail", ev.length >= 4 && (!corsApplied || ev[0].action === "cors.applied") && ev.every((e) => e.actor_email === ADMIN.email) && ev.some((e) => e.action === "settings.saved" && e.fields.includes("access_key_id") && e.fields.includes("secret_access_key") && e.fields.includes("bucket")), ev.slice(0, 5))
  check("the change log never contains secret values", !JSON.stringify(ev).includes(S3.secret) && !JSON.stringify(ev).includes(S3.key), ev.slice(0, 3))
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { public_url_template: "no placeholder" } })
  check("template without {key} is refused", r.status === 400 && /\{key\}/.test(r.json.message), r.json)
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { public_url_template: "{public_url}/cdn-cgi/image/format=auto/{key}" } })
  check("template saved", r.status === 200 && r.json.settings.public_url_template === "{public_url}/cdn-cgi/image/format=auto/{key}", r.json)
  await new Promise((resolve) => setTimeout(resolve, 700))
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "t.png", type: "image/png", content: PNG }]) })
  check("upload URL follows the template", r.status === 200 && r.json.files[0].url.startsWith(`${S3.publicUrl}/cdn-cgi/image/format=auto/${encodeKey(P)}medusa/t-`), r.json)
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { public_url_template: "" } })
  check("template cleared", r.status === 200 && r.json.settings.public_url_template === null, r.json)
  await new Promise((resolve) => setTimeout(resolve, 700))

  console.log("\nLive reconfiguration")
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { prefix: `${P}shop/2026` } })
  check("prefix changed", r.json.settings?.prefix === `${P}shop/2026/`, r.json)
  await new Promise((resolve) => setTimeout(resolve, 700)) // settings_cache_ttl_ms: 500 in the test app, no event bus
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "c.png", type: "image/png", content: PNG }]) })
  check("next upload uses the new prefix without a restart", r.status === 200 && r.json.files[0].id.startsWith(`${P}shop/2026/c-`), r.json)

  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { access_key_id: null, secret_access_key: null } })
  check("credentials removed: not configured again", r.status === 200 && r.json.settings.configured === false && r.json.settings.has_credentials === false && r.json.settings.missing.join() === "access_key_id,secret_access_key", r.json)
  await new Promise((resolve) => setTimeout(resolve, 700))
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "d.png", type: "image/png", content: PNG }]) })
  check("upload fails again with the configuration message", r.status === 400 && /not configured/.test(r.json.message), r.json)

  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { access_key_id: S3.key, secret_access_key: S3.secret } })
  check("credentials re-entered", r.json.settings?.configured === true, r.json)

  console.log("\nEncryption key rotation (medusa exec)")
  const NEW_KEY = "fedcba9876543210".repeat(4)
  const rotate = (oldKey, newKey) =>
    spawnSync("node", [GUARD, MEDUSA, "exec", path.join(PLUGIN_DIR, ".medusa/server/src/scripts/rotate-encryption-key.js")], {
      cwd: APP_DIR,
      env: { ...env, R2_ENCRYPTION_KEY_OLD: oldKey, R2_ENCRYPTION_KEY: newKey },
      encoding: "utf8",
    })
  let rot = rotate(NEW_KEY, ENCRYPTION_KEY)
  check("rotation with the wrong old key is refused", rot.status !== 0 && /encrypted with key/.test(rot.stdout + rot.stderr), (rot.stdout + rot.stderr).slice(-300))
  rot = rotate(ENCRYPTION_KEY, NEW_KEY)
  check("rotation re-encrypts the credentials with the new key", rot.status === 0 && /re-encrypted with key/.test(rot.stdout + rot.stderr) && !(rot.stdout + rot.stderr).includes(S3.secret), (rot.stdout + rot.stderr).slice(-300))
  await new Promise((resolve) => setTimeout(resolve, 700))
  r = await api("GET", "/admin/r2/settings", { headers: admin })
  check("the running server (old key) now reports a key mismatch and is not configured", r.status === 200 && r.json.settings.encryption.status === "mismatch" && r.json.settings.configured === false, r.json.settings)
  check("the change log records the rotation without an actor and without key values", r.json.events[0].action === "encryption_key.rotated" && r.json.events[0].actor_email === null && !JSON.stringify(r.json.events[0]).includes(NEW_KEY) && !JSON.stringify(r.json.events[0]).includes(ENCRYPTION_KEY), r.json.events[0])
  rot = rotate(NEW_KEY, ENCRYPTION_KEY)
  await new Promise((resolve) => setTimeout(resolve, 700))
  r = await api("GET", "/admin/r2/settings", { headers: admin })
  check("rotating back restores the running server", rot.status === 0 && r.json.settings.encryption.status === "ok" && r.json.settings.configured === true, r.json.settings)
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "after-rotation.png", type: "image/png", content: PNG }]) })
  check("uploads work with the rotated credentials", r.status === 200 && (await fetch(r.json.files[0].url)).status === 200, r.json)

  await migrationChecks(admin)
}

/** migrate-to-r2 (medusa exec): local static/ → R2 with dry-run, verify, rewrite, resume, failure, rollback */
async function migrationChecks(admin) {
  console.log("\nMigration static/ → R2 (medusa exec)")
  const staticDir = path.join(STATE_DIR, "static")
  const reportDir = path.join(STATE_DIR, "r2-migration")
  fs.rmSync(staticDir, { recursive: true, force: true })
  fs.rmSync(reportDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(staticDir, "products"), { recursive: true })
  const bigFile = Buffer.alloc(6 * 1024 * 1024, 7)
  fs.writeFileSync(path.join(staticDir, "products", "talenan jati.png"), PNG)
  fs.writeFileSync(path.join(staticDir, "catalog.csv"), "sku,title\n1,Talenan")
  fs.writeFileSync(path.join(staticDir, "products", "big.bin"), bigFile)
  const BASE_URL = "http://files.e2e.test/static"
  const oldUrls = {
    png: `${BASE_URL}/products/talenan%20jati.png`,
    csv: `${BASE_URL}/catalog.csv`,
    big: `${BASE_URL}/products/big.bin`,
    missing: `${BASE_URL}/products/gone.png`,
  }
  let r = await api("POST", "/admin/products", { headers: admin, body: { title: "Migration test", options: [{ title: "Size", values: ["One"] }], thumbnail: oldUrls.png, images: [{ url: oldUrls.png }, { url: oldUrls.big }, { url: "https://elsewhere.test/x.png" }] } })
  check("product with old image URLs created", r.status === 200 && r.json.product?.id, r.json)
  const productId = r.json.product?.id
  psql(`CREATE TABLE IF NOT EXISTS e2e_media (id serial primary key, url text)`, DB_NAME)
  psql(`INSERT INTO e2e_media (url) VALUES ('${oldUrls.csv}'), ('${oldUrls.missing}')`, DB_NAME)
  const prefix = `${P}shop/2026/`
  const newUrl = (rel) => `${S3.publicUrl}/${encodeKey(prefix + rel)}`
  const migrate = (...words) =>
    spawnSync("node", [GUARD, MEDUSA, "exec", path.join(PLUGIN_DIR, ".medusa/server/src/scripts/migrate-to-r2.js"), "source=local", `static-dir=${staticDir}`, `base-url=${BASE_URL}`, `report=${reportDir}`, "tables=image.url,product.thumbnail,e2e_media.url", ...words], { cwd: APP_DIR, env, encoding: "utf8" })
  const reports = () => fs.readdirSync(reportDir).filter((f) => f.startsWith("report-")).sort()
  const lastReport = () => fs.readFileSync(path.join(reportDir, reports().at(-1)), "utf8")
  const dbUrls = () => ({
    thumbnail: psql(`SELECT thumbnail FROM product WHERE id = '${productId}'`, DB_NAME).trim(),
    images: psql(`SELECT url FROM image WHERE product_id = '${productId}' ORDER BY url`, DB_NAME).trim().split("\n").sort(),
    media: psql(`SELECT url FROM e2e_media ORDER BY id`, DB_NAME).trim().split("\n"),
  })

  let out = migrate("dry-run")
  let csv = lastReport()
  check("dry run lists every URL under base-url with its size and touches nothing", out.status === 0 && /dry run.*3 file\(s\)/.test(out.stdout + out.stderr) && (csv.match(/,dry-run,/g) ?? []).length === 3 && /,failed,/.test(csv) && !(await objectExists(S3.bucket, `${prefix}products/talenan jati.png`)) && dbUrls().thumbnail === oldUrls.png, { out: (out.stdout + out.stderr).slice(-400), csv })

  out = migrate()
  csv = lastReport()
  const big = await s3.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: `${prefix}products/big.bin` })).catch(() => null)
  const png = await s3.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: `${prefix}products/talenan jati.png` })).catch(() => null)
  check("files are copied under the prefix with sniffed type, verified size and the configured Cache-Control", out.status === 0 && png?.ContentType === "image/png" && png?.ContentLength === PNG.length && big?.ContentLength === bigFile.length && png?.CacheControl === "public, max-age=600", { out: (out.stdout + out.stderr).slice(-400), png: png?.ContentType, big: big?.ContentLength })
  check("report: 3 rewritten, the missing file failed, the foreign URL untouched", (csv.match(/,rewritten,/g) ?? []).length === 3 && /gone\.png.*,failed,/.test(csv) && !csv.includes("elsewhere.test"), csv)
  let db = dbUrls()
  check("URLs rewritten in product.thumbnail, image.url and the extra table; failed + foreign URLs unchanged", db.thumbnail === newUrl("products/talenan jati.png") && db.images.join() === [newUrl("products/big.bin"), newUrl("products/talenan jati.png"), "https://elsewhere.test/x.png"].sort().join() && db.media.join() === `${newUrl("catalog.csv")},${oldUrls.missing}`, db)
  let res = await fetch(db.thumbnail)
  check("the new thumbnail URL serves the file from R2", res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(PNG), res.status)
  check("source files were not deleted", fs.existsSync(path.join(staticDir, "products", "talenan jati.png")) && fs.existsSync(path.join(staticDir, "products", "big.bin")))

  fs.writeFileSync(path.join(staticDir, "products", "gone.png"), PNG)
  out = migrate("resume")
  csv = lastReport()
  check("resume skips verified files and copies the one that failed before", out.status === 0 && (csv.match(/,skipped,/g) ?? []).length === 0 && (csv.match(/,rewritten,/g) ?? []).length === 1 && /gone\.png.*,rewritten,/.test(csv) && dbUrls().media[1] === newUrl("products/gone.png"), { out: (out.stdout + out.stderr).slice(-300), csv })

  out = migrate("rollback")
  db = dbUrls()
  check("rollback restores the old URLs and deletes nothing", out.status === 0 && /rolled back 5 row/.test(out.stdout + out.stderr) && db.thumbnail === oldUrls.png && db.media.join() === `${oldUrls.csv},${oldUrls.missing}` && (await objectExists(S3.bucket, `${prefix}products/talenan jati.png`)) && fs.existsSync(path.join(staticDir, "catalog.csv")), { out: (out.stdout + out.stderr).slice(-300), db })
}

/** R2_E2E_OPTIONS=1: no Admin row, everything from the provider options */
async function optionsChecks() {
  const admin = await login()
  console.log("\nProvider options as the only source")
  let r = await api("GET", "/admin/r2/settings", { headers: admin })
  check("settings resolved from options", r.status === 200 && r.json.settings.configured === true && r.json.settings.source === "options" && r.json.settings.access_key_id_hint === "••••", r.json)
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "a.png", type: "image/png", content: PNG }]) })
  check("upload works with options only", r.status === 200 && r.json.files[0].url.startsWith(`${S3.publicUrl}/a-`), r.json)
  check("…served publicly", (await fetch(r.json.files[0].url)).status === 200)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
