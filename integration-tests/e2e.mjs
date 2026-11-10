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
// Every medusa command goes through scripts/guard.mjs (r2-spike-* containers and ports 9600+ only).
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

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
} = require("@aws-sdk/client-s3")

const DB_NAME = "r2_e2e"
const PG_CONTAINER = process.env.R2_PG_CONTAINER || "r2-spike-pg"
const PG_WAIT_S = 60
const PORT = 9600
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN = { email: "admin@e2e.test", password: "e2e-password-123" }
const ENCRYPTION_KEY = "0123456789abcdef".repeat(4)

const S3 = {
  endpoint: process.env.R2_E2E_S3 || "http://127.0.0.1:59000",
  key: process.env.R2_E2E_S3_KEY || "minioadmin",
  secret: process.env.R2_E2E_S3_SECRET || "minioadmin",
  bucket: "r2-e2e-public",
  privateBucket: "r2-e2e-private",
}
// MinIO serves anonymous reads of a bucket with a public policy at <endpoint>/<bucket>: the stand-in for r2.dev
S3.publicUrl = `${S3.endpoint}/${S3.bucket}`

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

function psql(sql) {
  run("docker", ["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
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

async function api(method, url, { body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: raw ? headers : { "content-type": "application/json", ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
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
    if (OPTIONS_RUN) await optionsChecks()
    else await checks()
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
    body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: S3.secret, bucket: S3.bucket, public_url: S3.publicUrl, private_bucket: S3.privateBucket, prefix: "medusa" },
  })
  const names = (r.json.checks ?? []).map((c) => `${c.name}:${c.ok}`)
  check("all checks pass incl. public URL and private bucket", r.status === 200 && r.json.ok === true && names.join(",") === "bucket:true,write:true,read:true,public_url:true,private_bucket:true,delete:true", r.json)
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: "wrong", bucket: S3.bucket } })
  check("wrong secret → bucket check fails with HTTP 403", r.json.ok === false && r.json.checks[0].name === "bucket" && /403|Forbidden|SignatureDoesNotMatch/.test(r.json.checks[0].detail), r.json)
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: S3.secret, bucket: "does-not-exist-" + Date.now() } })
  check("missing bucket → bucket check fails with HTTP 404", r.json.ok === false && /404|NotFound|NoSuchBucket/.test(r.json.checks[0].detail), r.json)
  r = await api("POST", "/admin/r2/test-connection", { headers: admin, body: { endpoint: S3.endpoint, access_key_id: S3.key, secret_access_key: S3.secret, bucket: S3.privateBucket, public_url: `${S3.endpoint}/${S3.privateBucket}` } })
  check("public URL that does not serve the bucket → only public_url fails", r.json.ok === false && r.json.checks.filter((c) => !c.ok).map((c) => c.name).join() === "public_url", r.json)
  check("the probe object was deleted again", (await s3.send(new ListObjectsV2Command({ Bucket: S3.bucket }))).KeyCount === 0)

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
      endpoint: S3.endpoint,
      access_key_id: S3.key,
      secret_access_key: S3.secret,
      bucket: S3.bucket,
      public_url: `${S3.publicUrl}/`,
      prefix: "/medusa/",
      cache_control: "public, max-age=600",
      download_url_ttl: 120,
    },
  })
  const st = r.json.settings
  check("settings saved: configured, source admin, hint masked, values normalized", r.status === 200 && st.configured === true && st.source === "admin" && st.has_credentials === true && st.access_key_id_hint === "••••" && st.public_url === S3.publicUrl && st.prefix === "medusa/" && st.endpoint === S3.endpoint && st.endpoint_is_custom === true && st.download_url_ttl === 120 && st.encryption.status === "ok" && st.credentials_saved_at, st)
  check("saved settings response never contains the secret", !JSON.stringify(r.json).includes(S3.secret) && !JSON.stringify(r.json).includes("encrypted"), r.json)
  const row = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", DB_NAME, "-tAc", "select access_key_id_encrypted, secret_access_key_encrypted from r2_setting"], { encoding: "utf8" }).stdout
  check("credentials are stored encrypted (v1.<iv>.<tag>.<ct>), never in clear", /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\|v1\./.test(row.trim()) && !row.includes(S3.secret), row.trim().slice(0, 80))

  console.log("\nUploads through the Admin API (no restart)")
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "talenan jati.png", type: "image/png", content: PNG }]) })
  const up = r.json.files?.[0]
  check("upload succeeds and returns the public URL", r.status === 200 && up && up.url.startsWith(`${S3.publicUrl}/medusa/talenan%20jati-`) && up.url.endsWith(".png") && up.id.startsWith("medusa/talenan jati-"), r.json)
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

  console.log("\nPrivate files")
  r = await api("POST", "/admin/e2e/file", { headers: admin, body: { filename: "exports/products.csv", content: Buffer.from("id,title\n1,A").toString("base64"), mimeType: "text/csv", access: "private" } })
  const priv = r.json.file
  check("private file without a private bucket goes to the main bucket, URL is presigned", r.status === 200 && priv.id.startsWith("medusa/exports/products-") && /X-Amz-Signature/.test(priv.url) && (await objectExists(S3.bucket, priv.id)), r.json)
  r = await api("GET", `/admin/e2e/file?key=${encodeURIComponent(priv.id)}`, { headers: admin })
  check("getAsBuffer and retrieveFile work", r.status === 200 && r.json.content === "id,title\n1,A" && /X-Amz-Signature/.test(r.json.url), r.json)

  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { private_bucket: S3.privateBucket } })
  check("private bucket saved", r.status === 200 && r.json.settings.private_bucket === S3.privateBucket, r.json)
  r = await api("POST", "/admin/e2e/file", { headers: admin, body: { filename: "exports/orders.csv", content: Buffer.from("x").toString("base64"), mimeType: "text/csv", access: "private" } })
  const priv2 = r.json.file
  check("private file now lands in the private bucket", r.status === 200 && (await objectExists(S3.privateBucket, priv2.id)) && !(await objectExists(S3.bucket, priv2.id)), r.json)
  r = await api("GET", `/admin/e2e/file?key=${encodeURIComponent(priv2.id)}`, { headers: admin })
  check("reads locate the object in the private bucket", r.status === 200 && r.json.content === "x" && (await fetch(r.json.url)).status === 200, r.json)
  r = await api("GET", `/admin/e2e/file?key=${encodeURIComponent(priv.id)}`, { headers: admin })
  check("…and still find older private files in the main bucket", r.status === 200 && r.json.content === "id,title\n1,A", r.json)
  r = await api("DELETE", `/admin/e2e/file?key=${encodeURIComponent(priv2.id)}`, { headers: admin })
  check("delete removes it from the private bucket", r.status === 200 && !(await objectExists(S3.privateBucket, priv2.id)), r.json)
  r = await api("POST", "/admin/e2e/file", { headers: admin, body: { filename: "public.txt", content: Buffer.from("hello").toString("base64"), mimeType: "text/plain", access: "public" } })
  check("public files still go to the public bucket", r.status === 200 && (await objectExists(S3.bucket, r.json.file.id)) && (await (await fetch(r.json.file.url)).text()) === "hello", r.json)

  console.log("\nPresigned uploads")
  r = await api("POST", "/admin/uploads/presigned-urls", { headers: admin, body: { originalname: "photo.png", mime_type: "image/png", size: PNG.length, access: "public" } })
  check("presigned upload URL issued under the prefix", r.status === 200 && /X-Amz-Signature/.test(r.json.url) && r.json.filename.startsWith("medusa/") && r.json.filename.endsWith(".png"), r.json)
  res = await fetch(r.json.url, { method: "PUT", body: PNG, headers: { "content-type": "image/png" } })
  check("PUT to the presigned URL stores the object", res.status === 200 && (await objectExists(S3.bucket, r.json.filename)), res.status)
  res = await fetch(`${S3.publicUrl}/${r.json.filename}`)
  check("…which is served from the public URL", res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(PNG), res.status)

  console.log("\nLive reconfiguration")
  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { prefix: "shop/2026" } })
  check("prefix changed", r.json.settings?.prefix === "shop/2026/", r.json)
  await new Promise((resolve) => setTimeout(resolve, 700)) // settings_cache_ttl_ms: 500 in the test app, no event bus
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "c.png", type: "image/png", content: PNG }]) })
  check("next upload uses the new prefix without a restart", r.status === 200 && r.json.files[0].id.startsWith("shop/2026/c-"), r.json)

  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { access_key_id: null, secret_access_key: null } })
  check("credentials removed: not configured again", r.status === 200 && r.json.settings.configured === false && r.json.settings.has_credentials === false && r.json.settings.missing.join() === "access_key_id,secret_access_key", r.json)
  await new Promise((resolve) => setTimeout(resolve, 700))
  r = await api("POST", "/admin/uploads", { headers: admin, raw: multipart([{ name: "d.png", type: "image/png", content: PNG }]) })
  check("upload fails again with the configuration message", r.status === 400 && /not configured/.test(r.json.message), r.json)

  r = await api("POST", "/admin/r2/settings", { headers: admin, body: { access_key_id: S3.key, secret_access_key: S3.secret } })
  check("credentials re-entered", r.json.settings?.configured === true, r.json)
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
