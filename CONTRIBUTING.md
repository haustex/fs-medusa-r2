# Contributing

Thank you for helping! Bug reports, fixes and translations are welcome. For larger changes please open an issue
first, so we can agree on the approach.

## Setup

Node.js 20.19+ or 22.12+, Docker (for the end-to-end Postgres and the S3-compatible store).

```bash
npm ci
npm run build
```

## Checks

Every pull request runs these in CI, against Medusa 2.19.0 and 2.22.2:

```bash
npm run lint
npm run typecheck        # the plugin and the Admin extension
npm run test:unit
npm run build
npm run pack:check       # what `npm pack` would publish
```

To try another Medusa release locally: `node scripts/use-medusa.mjs 2.22.2` (not saved; `npm ci` goes back).

## End-to-end tests

`integration-tests/e2e.mjs` creates a fresh database, migrates, starts Medusa on port 9600 with the provider
registered and RustFS (an S3-compatible server) standing in for R2, then drives the Admin API: settings, the
connection test, uploads, presigned URLs, private files, deletes and live reconfiguration.

```bash
docker run -d --name r2-spike-pg -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=r2_spike \
  -p 127.0.0.1:55435:5432 postgres:17-alpine
docker run -d --name r2-spike-minio -e RUSTFS_ACCESS_KEY=minioadmin -e RUSTFS_SECRET_KEY=minioadmin \
  -p 127.0.0.1:59000:9000 rustfs/rustfs:latest
npm run build && node integration-tests/e2e.mjs
R2_E2E_OPTIONS=1 node integration-tests/e2e.mjs    # provider options as the only source
```

`R2_ADMIN=1 R2_KEEP=1 node integration-tests/e2e.mjs` builds the Admin too and keeps the server running on
http://127.0.0.1:9600/app (login `admin@e2e.test` / `e2e-password-123`) to look at the settings page.

Every Medusa command goes through `scripts/guard.mjs`, which refuses any database other than `127.0.0.1:55435`,
any Redis other than `127.0.0.1:56382` and HTTP ports below 9600.

## Database changes

Change the model in `src/modules/r2Settings/models`, then generate the migration against the throwaway database:

```bash
export DATABASE_URL=postgres://postgres:spike@127.0.0.1:55435/r2_spike REDIS_URL=redis://127.0.0.1:56382
npm run db:generate
```

If you add a column the provider reads, mirror it in `COLUMNS` in `src/lib/settings.ts`.

## Style

- Secrets never leave the server: API responses carry hints (`••••a1b2`), never values; log lines never include them.
- User-facing text in English and Indonesian (`src/admin/i18n/json`).
- Small commits with clear messages; update CHANGELOG.md under "Unreleased".
