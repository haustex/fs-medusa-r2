# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately:

- through GitHub: **Security → Report a vulnerability** on
  [haustex/fs-medusa-r2](https://github.com/haustex/fs-medusa-r2/security), or
- by e-mail to [dev@hauskayu.com](mailto:dev@hauskayu.com), subject "Security: medusa-storage-r2".

Include the plugin and Medusa versions, what an attacker can do, and steps to reproduce. We will confirm that we
received the report, keep you updated while we fix it, and credit you in the release notes if you wish.

## Scope

Of particular interest:

- reading the access key or secret through any Admin or Store route (they are only ever returned masked);
- writing to or reading from the bucket without an Admin login (presigned URLs are the intended exception, bounded
  by `download_url_ttl` / `upload_url_ttl`);
- path traversal in file names leading to objects outside the configured prefix;
- weaknesses in how the credentials are encrypted at rest (AES-256-GCM, key from `R2_ENCRYPTION_KEY`, the column
  name bound as additional authenticated data).

## Operating the plugin safely

- Generate `R2_ENCRYPTION_KEY` with `openssl rand -hex 32`, give the same value to every Medusa process (server and
  worker) and **back it up with the database**: without it the stored credentials cannot be read and have to be
  entered again.
- Create the R2 API token with **Object Read & Write** only, scoped to the bucket(s) the store uses. The plugin
  never needs to create or delete buckets.
- Put files Medusa marks private (exports, imports) in a separate **private bucket** without public access. In a
  single public bucket their keys are unguessable (ULID) but anyone holding the URL can read them.
- Use a custom domain in front of the bucket for production; the `r2.dev` URL is rate limited and meant for
  development.
