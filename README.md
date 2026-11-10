<p align="center">
  <a href="https://hauskayu.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
      <img src="docs/logo.svg" alt="Haus Kayu" width="260">
    </picture>
  </a>
</p>

# medusa-storage-r2

**Cloudflare R2 file storage for Medusa v2, configured from the Admin: paste the account ID, an R2 API token and
the bucket in Settings → Cloudflare R2, press Test connection, done.** Credentials are stored encrypted, a public
URL or custom domain serves the files, presigned uploads and downloads work, and changes apply without a restart.
Built by Haus Kayu for its own store.
<br>Penyimpanan file Cloudflare R2 untuk Medusa v2, diatur dari Admin: tempel Account ID, token API R2, dan nama
bucket, tes koneksi, selesai. Dibuat oleh Haus Kayu untuk tokonya sendiri.

[![npm](https://img.shields.io/npm/v/medusa-storage-r2)](https://www.npmjs.com/package/medusa-storage-r2)
[![CI](https://github.com/haustex/fs-medusa-r2/actions/workflows/ci.yml/badge.svg)](https://github.com/haustex/fs-medusa-r2/actions/workflows/ci.yml)
[![Medusa](https://img.shields.io/badge/Medusa-2.19%20%E2%80%93%202.22-7c3aed)](https://medusajs.com)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Community plugin, not a Cloudflare product.** Independent open source (MIT), not affiliated with or endorsed by
> Cloudflare. Works with any S3-compatible store through a custom endpoint, too.

### Compatibility

| Plugin | Medusa | Node | Tested in CI on |
| --- | --- | --- | --- |
| 0.1.x | 2.19.0 or newer 2.x (`^2.19.0`) | 20.19+ or 22.12+ | Medusa 2.19.0 and 2.22.2 |

### Quick start

```bash
npm install medusa-storage-r2
echo "R2_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env   # same value on server and worker
```

```ts
// medusa-config.ts
plugins: [{ resolve: "medusa-storage-r2", options: {} }],
modules: [
  {
    resolve: "@medusajs/medusa/file",
    options: {
      providers: [{ resolve: "medusa-storage-r2/providers/r2", id: "r2", options: {} }],
    },
  },
],
```

```bash
npx medusa db:migrate
```

Then open **Settings → Cloudflare R2** in the Admin, fill in the account ID, access key, secret, bucket and public
URL, press **Test connection**, then **Save**. The next upload goes to R2.
Full steps: [Installation](#installation) · [Cloudflare setup](#cloudflare-setup) · [Configuration](#configuration).

[English](#english) · [Bahasa Indonesia](#bahasa-indonesia)

| Settings page | Connection test |
| --- | --- |
| ![Settings → Cloudflare R2](docs/screenshots/admin-settings.png) | ![Every step of the connection test reported](docs/screenshots/admin-test-connection.png) |

---

## English

### Features

- **File Module provider** `fs_r2_r2` for Cloudflare R2: upload, streamed (multipart) upload, delete, presigned
  download URLs, presigned upload URLs, download stream and buffer: everything Medusa's Admin, import/export and
  your own code use.
- **Configured in the Admin**: account ID, jurisdiction (default / EU / FedRAMP), bucket, public URL, folder prefix,
  optional private bucket, Cache-Control, link lifetimes. No redeploy to change a bucket or rotate a token.
- **Credentials encrypted at rest** (AES-256-GCM, key from `R2_ENCRYPTION_KEY`), shown masked, saved as a pair.
  Fallback order: Admin → provider options → `R2_*` environment variables.
- **Test connection** before saving: HEAD bucket, write a probe object, read it back, fetch it through the public
  URL, HEAD the private bucket, delete the probe. Each step is reported, so "the r2.dev URL is not enabled" or "the
  token lacks write permission" is one line, not a guessing game.
- **Public and private files**: public files get `public_url/key`; files Medusa marks private (exports, imports) go
  to the private bucket when one is set and are served through presigned links.
- **S3-compatible stores** through a custom endpoint (MinIO, RustFS, Garage, …), which is also how the end-to-end
  tests run.
- English and Indonesian Admin texts.

### Requirements

- Medusa **2.19 or newer 2.x** (tested in CI on 2.19.0 and 2.22.2), Node 20.19+ or 22.12+.
- A Cloudflare account with R2 enabled and one bucket (two if you want private files kept apart).

### Installation

```bash
npm install medusa-storage-r2
```

`medusa-config.ts`: register the plugin and make it the File Module's provider. Medusa uses one file provider at a
time, so this replaces `@medusajs/medusa/file-local` (or `file-s3`).

```ts
module.exports = defineConfig({
  // …
  plugins: [{ resolve: "medusa-storage-r2", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "medusa-storage-r2/providers/r2",
            id: "r2",
            options: {
              // all optional; the Admin settings take precedence
              // account_id, bucket, public_url, prefix, access_key_id, secret_access_key, …
            },
          },
        ],
      },
    },
  ],
})
```

Then run the migration and set the encryption key:

```bash
npx medusa db:migrate
echo "R2_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env   # same value on server and worker
```

Until the store is configured, uploads fail with `Cloudflare R2 is not configured (missing: …). Open Settings →
Cloudflare R2 …`; nothing else in Medusa is affected.

### Cloudflare setup

1. **Bucket**: Cloudflare dashboard → R2 → Create bucket. Note the **Account ID** shown on the R2 overview page.
2. **Public access** (so product images have a URL): bucket → Settings → Public access. Either enable the
   `r2.dev` subdomain (development; rate limited) or connect a **custom domain** on your zone (production).
   The resulting `https://pub-….r2.dev` or `https://cdn.your-store.com` is the plugin's **Public URL**.
3. **API token**: R2 → Manage R2 API Tokens → Create API Token, permission **Object Read & Write**, scoped to the
   bucket(s). Copy the **Access Key ID** and **Secret Access Key** (the S3 pair, not the Cloudflare API token).
4. Optional **private bucket** for exports and imports: a second bucket without public access, same token.

### Configuration

Open **Settings → Cloudflare R2** in the Admin:

| Field | Meaning |
| --- | --- |
| Account ID | 32 hex characters; the S3 endpoint `https://<account>.r2.cloudflarestorage.com` is derived from it. |
| Jurisdiction | `default`, `eu` or `fedramp`: only when the bucket was created with one; changes the endpoint host. |
| S3 endpoint | Fill in only for another S3-compatible store. Overrides account ID + jurisdiction. |
| Access Key ID / Secret | The R2 API token pair. Saved together, encrypted; the Admin shows `••••a1b2`. |
| Bucket | Where public files live. |
| Public URL | `https://pub-….r2.dev` or your custom domain. Without it public files get temporary presigned links and a warning is logged. |
| Folder (prefix) | Optional folder inside the bucket. Keys look like `<prefix>/<name>-<ulid>.<ext>`. |
| Private bucket | Optional bucket for files Medusa marks private. Empty: the same bucket. |
| Cache-Control | Stored with every upload. Default `public, max-age=31536000, immutable` (keys are unique). |
| Download / upload links | Lifetime of presigned links in seconds, 60 to 604800 (7 days, the SigV4 maximum). |

**Test connection** uses the values in the form (saved or not) and writes one probe object under
`<prefix>/.medusa-storage-r2/`, which it deletes again.

Lookup order for every value: Admin → provider `options` → environment:

| Env var | Option | Setting |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | `account_id` | Account ID |
| `R2_JURISDICTION` | `jurisdiction` | Jurisdiction |
| `R2_ENDPOINT` | `endpoint` | S3 endpoint |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | `access_key_id`, `secret_access_key` | Credentials (always both from one source) |
| `R2_BUCKET` | `bucket` | Bucket |
| `R2_PUBLIC_URL` | `public_url` | Public URL |
| `R2_PREFIX` | `prefix` | Folder |
| `R2_PRIVATE_BUCKET` | `private_bucket` | Private bucket |
| `R2_CACHE_CONTROL` | `cache_control` | Cache-Control |
| – | `download_url_ttl`, `upload_url_ttl` | Link lifetimes |
| – | `settings_cache_ttl_ms` | How long a process caches the settings (default 60000) |
| `R2_ENCRYPTION_KEY` | – | 64 hex chars (`openssl rand -hex 32`). Needed to store credentials in the Admin. Back it up with the database. |

Settings saved in the Admin reach the other Medusa processes (worker) through the `r2.settings.updated` event and
in any case within `settings_cache_ttl_ms`.

### Moving an existing store to R2

Files uploaded before the switch stay where they were (for `file-local`: `static/` on the server) and their URLs
in the database still point there. Keep serving that folder until the images are re-uploaded, or copy the folder
into the bucket under the same keys and rewrite the URLs. A migration command is planned for 0.2.0.

### Plugin options

```ts
plugins: [{ resolve: "medusa-storage-r2", options: { showCredit: true } }]
```

`showCredit` (default `true`) shows the small "by Haus Kayu" line under the settings page.

### FAQ

**Does R2 need ACLs?** No, and the plugin never sends any. Public access is a bucket-level setting in Cloudflare;
the plugin only decides which bucket an object goes to.

**Why does `GET /admin/uploads/:id` return a presigned URL for a public file?** That route always asks the provider
for a presigned download link; product images and other public files keep their plain public URL in the database.

**Can I use it without the Admin page?** Yes: provider options or `R2_*` variables alone configure it. The Admin
page then shows them as read-only hints (`Source: medusa-config.ts`).

**What if I lose `R2_ENCRYPTION_KEY`?** Uploads stop with a clear message, the Admin shows "key mismatch", and you
enter the access key and secret again. Nothing in the bucket is affected.

### Security

- Secrets are never returned by any route or written to logs; the Admin receives `••••` + the last four
  characters of the access key ID only.
- Ciphertext format `v1.<iv>.<tag>.<ciphertext>` (AES-256-GCM, 96-bit IV, the column name as AAD) and a key
  fingerprint next to it, so a changed key is reported instead of producing garbage.
- File names are sanitized (`..`, leading slashes and `.` segments removed) and every stored key carries a ULID.
- All Admin routes require an authenticated Admin user; request bodies are validated with strict schemas.
- See [SECURITY.md](SECURITY.md) for reporting and operating guidance.

---

## Bahasa Indonesia

### Fitur

- **Provider File Module** `fs_r2_r2` untuk Cloudflare R2: unggah, unggah streaming (multipart), hapus, tautan
  unduh presigned, tautan unggah presigned, stream dan buffer: semua yang dipakai Admin Medusa, impor/ekspor, dan
  kode Anda sendiri.
- **Diatur dari Admin**: Account ID, yurisdiksi, bucket, URL publik, folder, bucket privat opsional, Cache-Control,
  masa berlaku tautan. Ganti bucket atau rotasi token tanpa deploy ulang.
- **Kredensial terenkripsi** (AES-256-GCM, kunci dari `R2_ENCRYPTION_KEY`), ditampilkan tersamar, disimpan
  berpasangan. Urutan fallback: Admin → opsi provider → environment variable `R2_*`.
- **Tes koneksi** sebelum menyimpan: cek bucket, tulis objek uji, baca ulang, ambil lewat URL publik, cek bucket
  privat, hapus. Tiap langkah dilaporkan terpisah.
- **File publik dan privat**: file publik dapat `public_url/key`; file yang Medusa tandai privat (ekspor, impor)
  masuk ke bucket privat kalau diisi dan dilayani lewat tautan presigned.
- Teks Admin dalam Bahasa Indonesia dan Inggris.

### Kebutuhan

- Medusa **2.19 atau 2.x yang lebih baru** (diuji di CI pada 2.19.0 dan 2.22.2), Node 20.19+ atau 22.12+.
- Akun Cloudflare dengan R2 aktif dan satu bucket (dua kalau file privat mau dipisah).

### Pasang

```bash
npm install medusa-storage-r2
```

Di `medusa-config.ts`, daftarkan plugin dan jadikan provider File Module (menggantikan `file-local` / `file-s3`;
Medusa hanya memakai satu provider file):

```ts
plugins: [{ resolve: "medusa-storage-r2", options: {} }],
modules: [
  {
    resolve: "@medusajs/medusa/file",
    options: {
      providers: [{ resolve: "medusa-storage-r2/providers/r2", id: "r2", options: {} }],
    },
  },
],
```

Lalu:

```bash
npx medusa db:migrate
echo "R2_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env   # nilai sama di server dan worker
```

### Setup di Cloudflare

1. **Bucket**: dashboard Cloudflare → R2 → Create bucket. Catat **Account ID** di halaman overview R2.
2. **Akses publik**: bucket → Settings → Public access. Aktifkan subdomain `r2.dev` (untuk development, dibatasi
   rate limit) atau hubungkan **custom domain** (produksi). URL yang didapat adalah **URL publik** di plugin.
3. **Token API**: R2 → Manage R2 API Tokens → Create API Token, izin **Object Read & Write**, dibatasi ke bucket.
   Salin **Access Key ID** dan **Secret Access Key** (pasangan S3, bukan token API Cloudflare).
4. Opsional **bucket privat** untuk ekspor/impor: bucket kedua tanpa akses publik, token yang sama.

### Konfigurasi

Buka **Settings → Cloudflare R2** di Admin, isi Account ID, kredensial, bucket, dan URL publik, klik **Tes koneksi**,
lalu **Simpan**. Unggahan berikutnya langsung ke R2, tanpa restart. Arti tiap kolom dan daftar environment variable
ada di bagian [Configuration](#configuration) di atas.

### Pindah dari penyimpanan lokal

File yang diunggah sebelum pindah tetap di tempat lama (`static/` untuk `file-local`) dan URL-nya di database tetap
menunjuk ke sana. Tetap layani folder itu sampai gambar diunggah ulang, atau salin isinya ke bucket dengan key yang
sama dan perbarui URL-nya. Perintah migrasi direncanakan untuk 0.2.0.

---

## Development

```bash
npm ci
npm run build
npm run lint && npm run typecheck && npm run test:unit
# E2E (Postgres + RustFS on the spike ports, see CONTRIBUTING.md)
node integration-tests/e2e.mjs
```

## Built for hauskayu.com

[hauskayu.com](https://hauskayu.com), the Haus Kayu store (teak furniture and crafts from Jepara), is moving its product
images and documents from the server's disk to R2 with this plugin, next to its payment and shipping plugins.

## Other plugins by Haus Kayu

- [medusa-payment-doit](https://github.com/haustex/pg-medusa-doit): doit.id payments (QRIS, Virtual Account) for Indonesia.
- [medusa-payment-manual-transfer](https://github.com/haustex/pg-medusa-manual-transfer): manual bank transfer with
  payment-proof upload and admin verification.
- [medusa-fulfillment-zone-rate](https://github.com/haustex/fl-medusa-zone-rate): calculated shipping by zone and
  chargeable weight, with shipment tracking.

## About Haus Kayu

[Haus Kayu](https://hauskayu.com) makes custom teak furniture and wooden crafts in Jepara, Indonesia, and runs its
own store on Medusa. The plugins we need and cannot find, we build and publish.

## Support

- Issues and feature requests: [GitHub issues](https://github.com/haustex/fs-medusa-r2/issues)
- E-mail: [dev@hauskayu.com](mailto:dev@hauskayu.com)

## Disclaimer

This is a community plugin, not a Cloudflare product. Cloudflare and R2 are trademarks of Cloudflare, Inc.; MinIO
and RustFS of their respective owners. Use at your own risk; see the [license](LICENSE).

## License

[MIT](LICENSE) © Haus Kayu
