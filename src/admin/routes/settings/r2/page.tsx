import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CheckCircle, ExclamationCircle, XCircle } from "@medusajs/icons"
import { Alert, Badge, Button, Container, Heading, Input, Label, Select, Text, toast } from "@medusajs/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CreditFooter } from "../../../components/credit-footer"
import { Loading } from "../../../components/states"
import { r2Keys, useR2Settings } from "../../../lib/api"
import { sdk } from "../../../lib/client"
import type { ConnectionTestResult, CorsResponse, Jurisdiction, PublicSettings, SettingEvent, SettingsResponse } from "../../../lib/types"

const JURISDICTIONS: Jurisdiction[] = ["default", "eu", "fedramp"]
const ACCOUNT_ID = /^[0-9a-fA-F]{32}$/
const HTTP_URL = /^https?:\/\/\S+$/i
const ADMIN_ORIGIN = typeof window !== "undefined" ? window.location.origin : ""

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} kB`
  return `${n} B`
}

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <Container className="divide-y p-0">
    <div className="flex flex-col gap-y-1 px-6 py-4">
      <Heading level="h2">{title}</Heading>
      {hint && <Text size="small" className="text-ui-fg-subtle">{hint}</Text>}
    </div>
    <div className="flex flex-col gap-y-5 px-6 py-4">{children}</div>
  </Container>
)

const Field = ({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-1 gap-2 md:grid-cols-[240px_1fr] md:gap-6">
    <div className="flex flex-col gap-y-1">
      <Label htmlFor={id} size="small" weight="plus">{label}</Label>
      {hint && <Text size="xsmall" className="text-ui-fg-subtle">{hint}</Text>}
    </div>
    <div className="flex min-w-0 flex-col gap-y-1">{children}</div>
  </div>
)

const R2SettingsPage = () => {
  const { data, isLoading } = useR2Settings()
  if (isLoading || !data) return <Loading />
  return <SettingsForm settings={data.settings} events={data.events ?? []} />
}

const SettingsForm = ({ settings, events }: { settings: PublicSettings; events: SettingEvent[] }) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [accountId, setAccountId] = useState(settings.account_id ?? "")
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>(settings.jurisdiction)
  const [endpoint, setEndpoint] = useState(settings.endpoint_is_custom ? (settings.endpoint ?? "") : "")
  const [accessKeyId, setAccessKeyId] = useState("")
  const [secret, setSecret] = useState("")
  const [clearCredentials, setClearCredentials] = useState(false)
  const [bucket, setBucket] = useState(settings.bucket ?? "")
  const [publicUrl, setPublicUrl] = useState(settings.public_url ?? "")
  const [publicUrlTemplate, setPublicUrlTemplate] = useState(settings.public_url_template ?? "")
  const [prefix, setPrefix] = useState(settings.prefix.replace(/\/$/, ""))
  const [privateBucket, setPrivateBucket] = useState(settings.private_bucket ?? "")
  const [cacheControl, setCacheControl] = useState(settings.cache_control)
  const [downloadTtl, setDownloadTtl] = useState(String(settings.download_url_ttl))
  const [uploadTtl, setUploadTtl] = useState(String(settings.upload_url_ttl))
  const [test, setTest] = useState<ConnectionTestResult | null>(null)
  const [cors, setCors] = useState<CorsResponse | null>(null)

  useEffect(() => {
    setAccountId(settings.account_id ?? "")
    setJurisdiction(settings.jurisdiction)
    setEndpoint(settings.endpoint_is_custom ? (settings.endpoint ?? "") : "")
    setBucket(settings.bucket ?? "")
    setPublicUrl(settings.public_url ?? "")
    setPublicUrlTemplate(settings.public_url_template ?? "")
    setPrefix(settings.prefix.replace(/\/$/, ""))
    setPrivateBucket(settings.private_bucket ?? "")
    setCacheControl(settings.cache_control)
    setDownloadTtl(String(settings.download_url_ttl))
    setUploadTtl(String(settings.upload_url_ttl))
    setClearCredentials(false)
  }, [settings])

  const typedCredentials = accessKeyId.trim() !== "" || secret.trim() !== ""
  const credentialsComplete = accessKeyId.trim() !== "" && secret.trim() !== ""
  const downloadTtlNum = Number(downloadTtl)
  const uploadTtlNum = Number(uploadTtl)
  const ttlOk = (n: number) => Number.isInteger(n) && n >= 60 && n <= 604800
  const valid =
    (!accountId.trim() || ACCOUNT_ID.test(accountId.trim())) &&
    (!endpoint.trim() || HTTP_URL.test(endpoint.trim())) &&
    (!publicUrl.trim() || HTTP_URL.test(publicUrl.trim())) &&
    (!publicUrlTemplate.trim() || publicUrlTemplate.includes("{key}")) &&
    (!typedCredentials || credentialsComplete) &&
    (!typedCredentials || settings.encryption.key_present) &&
    ttlOk(downloadTtlNum) &&
    ttlOk(uploadTtlNum)

  const derivedEndpoint = accountId.trim() && ACCOUNT_ID.test(accountId.trim())
    ? `https://${accountId.trim().toLowerCase()}.${jurisdiction === "default" ? "" : `${jurisdiction}.`}r2.cloudflarestorage.com`
    : null

  const overrides = () => ({
    account_id: accountId.trim(),
    jurisdiction,
    endpoint: endpoint.trim(),
    bucket: bucket.trim(),
    public_url: publicUrl.trim(),
    prefix: prefix.trim(),
    private_bucket: privateBucket.trim(),
  })

  const save = useMutation({
    mutationFn: () =>
      sdk.client.fetch<SettingsResponse>("/admin/r2/settings", {
        method: "POST",
        body: {
          ...overrides(),
          public_url_template: publicUrlTemplate.trim(),
          ...(credentialsComplete
            ? { access_key_id: accessKeyId.trim(), secret_access_key: secret.trim() }
            : clearCredentials
              ? { access_key_id: null, secret_access_key: null }
              : {}),
          cache_control: cacheControl.trim(),
          download_url_ttl: downloadTtlNum,
          upload_url_ttl: uploadTtlNum,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: r2Keys.settings })
      setAccessKeyId("")
      setSecret("")
      setTest(null)
      toast.success(t("r2.settings.saved"))
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const testConnection = useMutation({
    mutationFn: () =>
      sdk.client.fetch<ConnectionTestResult>("/admin/r2/test-connection", {
        method: "POST",
        body: {
          ...overrides(),
          origin: ADMIN_ORIGIN || undefined,
          ...(credentialsComplete ? { access_key_id: accessKeyId.trim(), secret_access_key: secret.trim() } : {}),
        },
      }),
    onSuccess: setTest,
    onError: (e) => toast.error((e as Error).message),
  })

  const applyCors = useMutation({
    mutationFn: () => sdk.client.fetch<CorsResponse>("/admin/r2/cors", { method: "POST", body: { origin: ADMIN_ORIGIN } }),
    onSuccess: (r) => {
      setCors(r)
      if (r.ok) {
        queryClient.invalidateQueries({ queryKey: r2Keys.settings })
        toast.success(r.added ? t("r2.settings.cors_applied", { origin: r.origin, rules: r.rules }) : t("r2.settings.cors_already", { origin: r.origin }))
      }
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const encryptionOk = settings.encryption.status === "ok" || settings.encryption.status === "unused"
  const canTest = (credentialsComplete || settings.has_credentials) && (bucket.trim() || settings.bucket)

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex flex-col gap-y-1">
          <div className="flex items-center gap-x-2">
            <Heading>{t("r2.settings.title")}</Heading>
            <Badge size="small" color={settings.configured ? "green" : "orange"}>
              {t(settings.configured ? "r2.settings.status.configured" : "r2.settings.status.not_configured")}
            </Badge>
          </div>
          <Text size="small" className="text-ui-fg-subtle">{t("r2.settings.description")}</Text>
        </div>
        <div className="flex gap-2">
          <Button size="small" variant="secondary" onClick={() => testConnection.mutate()} isLoading={testConnection.isPending} disabled={!canTest || testConnection.isPending}>
            {testConnection.isPending ? t("r2.settings.testing") : t("r2.settings.test")}
          </Button>
          <Button size="small" onClick={() => save.mutate()} isLoading={save.isPending} disabled={!valid || save.isPending}>
            {t("r2.settings.save")}
          </Button>
        </div>
      </Container>

      {!settings.provider_registered && (
        <Alert variant="warning">
          <Text size="small">{t("r2.settings.status.provider_missing")}</Text>
        </Alert>
      )}
      {!settings.configured && settings.missing.length > 0 && (
        <Alert variant="info">
          <Text size="small">{t("r2.settings.status.missing", { fields: settings.missing.join(", ") })}</Text>
        </Alert>
      )}

      {test && (
        <Alert variant={test.ok ? "success" : "error"} dismissible>
          <div className="flex flex-col gap-y-1">
            <Text size="small" weight="plus">
              {test.ok ? t("r2.settings.test_ok", { ms: test.latency_ms }) : t("r2.settings.test_failed", { ms: test.latency_ms })}
            </Text>
            <ul className="flex flex-col gap-y-0.5">
              {test.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-x-2">
                  {c.ok ? (
                    <CheckCircle className="mt-0.5 shrink-0 text-ui-fg-interactive" />
                  ) : c.warning ? (
                    <ExclamationCircle className="mt-0.5 shrink-0 text-ui-tag-orange-icon" />
                  ) : (
                    <XCircle className="mt-0.5 shrink-0 text-ui-fg-error" />
                  )}
                  <Text size="small">
                    {t(`r2.settings.checks.${c.name}`)}
                    {c.detail && <span className="text-ui-fg-subtle"> — {c.detail}</span>}
                  </Text>
                </li>
              ))}
            </ul>
          </div>
        </Alert>
      )}

      <Section title={t("r2.settings.connection")}>
        <Field id="r2-account" label={t("r2.settings.account_id")} hint={t("r2.settings.account_id_hint")}>
          <Input id="r2-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="font-mono" placeholder="0123456789abcdef0123456789abcdef" autoComplete="off" />
        </Field>
        <Field id="r2-jurisdiction" label={t("r2.settings.jurisdiction")} hint={t("r2.settings.jurisdiction_hint")}>
          <Select value={jurisdiction} onValueChange={(v) => setJurisdiction(v as Jurisdiction)}>
            <Select.Trigger id="r2-jurisdiction" className="w-64">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {JURISDICTIONS.map((j) => (
                <Select.Item key={j} value={j}>{t(`r2.settings.jurisdictions.${j}`)}</Select.Item>
              ))}
            </Select.Content>
          </Select>
        </Field>
        <Field id="r2-endpoint" label={t("r2.settings.endpoint")} hint={t("r2.settings.endpoint_hint")}>
          <Input id="r2-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="font-mono" placeholder={derivedEndpoint ?? "https://…"} autoComplete="off" />
          {!endpoint.trim() && derivedEndpoint && (
            <Text size="xsmall" className="text-ui-fg-muted">{t("r2.settings.endpoint_derived", { endpoint: derivedEndpoint })}</Text>
          )}
        </Field>
      </Section>

      <Section title={t("r2.settings.credentials")} hint={t("r2.settings.credentials_hint")}>
        <Field id="r2-access-key" label={t("r2.settings.access_key_id")}>
          <Input id="r2-access-key" type="password" autoComplete="off" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder={settings.access_key_id_hint ?? ""} className="font-mono" />
          <Text size="xsmall" className="text-ui-fg-muted">
            {t("r2.settings.current", { value: settings.access_key_id_hint ?? t("r2.settings.not_set") })} ·{" "}
            {t("r2.settings.source", { source: t(`r2.settings.sources.${settings.source}`) })}
          </Text>
        </Field>
        <Field id="r2-secret" label={t("r2.settings.secret_access_key")}>
          <Input id="r2-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={settings.has_credentials && settings.source === "admin" ? "••••••••" : ""} className="font-mono" />
          {settings.has_credentials && settings.source === "admin" && !typedCredentials && (
            <label className="flex items-center gap-x-2">
              <input type="checkbox" checked={clearCredentials} onChange={(e) => setClearCredentials(e.target.checked)} />
              <Text size="xsmall" className="text-ui-fg-subtle">{t("r2.settings.clear_credentials")}</Text>
            </label>
          )}
        </Field>
        <Field id="r2-encryption" label={t("r2.settings.encryption")}>
          <div className="flex items-center gap-x-2">
            {encryptionOk ? <CheckCircle className="text-ui-fg-interactive" /> : <ExclamationCircle className="text-ui-fg-error" />}
            <Text size="small" className={encryptionOk ? undefined : "text-ui-fg-error"}>
              {t(`r2.settings.encryption_status.${settings.encryption.status}`)}
            </Text>
          </div>
          {!settings.encryption.key_present && (
            <Text size="xsmall" className="text-ui-fg-error">{t("r2.settings.encryption_key_missing")}</Text>
          )}
        </Field>
      </Section>

      <Section title={t("r2.settings.storage")}>
        <Field id="r2-bucket" label={t("r2.settings.bucket")} hint={t("r2.settings.bucket_hint")}>
          <Input id="r2-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} className="font-mono" placeholder="my-store-media" autoComplete="off" />
        </Field>
        <Field id="r2-public-url" label={t("r2.settings.public_url")} hint={t("r2.settings.public_url_hint")}>
          <Input id="r2-public-url" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} className="font-mono" placeholder="https://pub-xxxxxxxx.r2.dev" autoComplete="off" />
        </Field>
        <Field id="r2-public-url-template" label={t("r2.settings.public_url_template")} hint={t("r2.settings.public_url_template_hint")}>
          <Input id="r2-public-url-template" value={publicUrlTemplate} onChange={(e) => setPublicUrlTemplate(e.target.value)} className="font-mono" placeholder="{public_url}/{key}" autoComplete="off" />
        </Field>
        <Field id="r2-prefix" label={t("r2.settings.prefix")} hint={t("r2.settings.prefix_hint")}>
          <Input id="r2-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} className="w-64 font-mono" placeholder="medusa" autoComplete="off" />
        </Field>
        <Field id="r2-private-bucket" label={t("r2.settings.private_bucket")} hint={t("r2.settings.private_bucket_hint")}>
          <Input id="r2-private-bucket" value={privateBucket} onChange={(e) => setPrivateBucket(e.target.value)} className="font-mono" placeholder="my-store-private" autoComplete="off" />
        </Field>
      </Section>

      <Section title={t("r2.settings.advanced")}>
        <Field id="r2-cache" label={t("r2.settings.cache_control")} hint={t("r2.settings.cache_control_hint")}>
          <Input id="r2-cache" value={cacheControl} onChange={(e) => setCacheControl(e.target.value)} className="font-mono" />
        </Field>
        <Field id="r2-download-ttl" label={t("r2.settings.download_url_ttl")} hint={t("r2.settings.download_url_ttl_hint")}>
          <Input id="r2-download-ttl" type="number" min={60} max={604800} step={1} value={downloadTtl} onChange={(e) => setDownloadTtl(e.target.value)} className="w-40" />
        </Field>
        <Field id="r2-upload-ttl" label={t("r2.settings.upload_url_ttl")} hint={t("r2.settings.upload_url_ttl_hint")}>
          <Input id="r2-upload-ttl" type="number" min={60} max={604800} step={1} value={uploadTtl} onChange={(e) => setUploadTtl(e.target.value)} className="w-40" />
        </Field>
        <Field id="r2-max-size" label={t("r2.settings.max_file_size")} hint={t("r2.settings.max_file_size_hint")}>
          <Text size="small" className="font-mono">{settings.max_file_size ? formatBytes(settings.max_file_size) : t("r2.settings.no_limit")}</Text>
        </Field>
      </Section>

      <Section title={t("r2.settings.cors")} hint={t("r2.settings.cors_hint")}>
        <div className="flex flex-col gap-y-3">
          <div>
            <Button size="small" variant="secondary" onClick={() => applyCors.mutate()} isLoading={applyCors.isPending} disabled={!settings.configured || !ADMIN_ORIGIN || applyCors.isPending}>
              {applyCors.isPending ? t("r2.settings.applying_cors") : t("r2.settings.apply_cors", { origin: ADMIN_ORIGIN })}
            </Button>
          </div>
          {cors && !cors.ok && (
            <Alert variant="warning" dismissible>
              <div className="flex flex-col gap-y-2">
                <Text size="small">{cors.message}</Text>
                <Text size="xsmall" className="text-ui-fg-subtle">{t("r2.settings.cors_manual")}</Text>
                <pre className="txt-compact-small overflow-x-auto rounded-md bg-ui-bg-subtle p-3 font-mono">{cors.policy_json}</pre>
                <div>
                  <Button size="small" variant="secondary" onClick={() => navigator.clipboard.writeText(cors.policy_json).then(() => toast.success(t("r2.settings.copied")))}>
                    {t("r2.settings.copy")}
                  </Button>
                </div>
              </div>
            </Alert>
          )}
        </div>
      </Section>

      <Section title={t("r2.settings.history")} hint={t("r2.settings.history_hint")}>
        {events.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">{t("r2.settings.history_empty")}</Text>
        ) : (
          <ul className="flex flex-col divide-y">
            {events.map((e) => (
              <li key={e.id} className="flex flex-col gap-y-0.5 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-2">
                  <Text size="small" weight="plus">{t(`r2.settings.actions.${e.action}`, { defaultValue: e.action })}</Text>
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {new Date(e.created_at).toLocaleString()} · {e.actor_email ?? t("r2.settings.history_system")}
                  </Text>
                </div>
                {(e.fields.length > 0 || e.detail) && (
                  <Text size="xsmall" className="font-mono text-ui-fg-muted">
                    {[e.fields.join(", "), e.detail].filter(Boolean).join(" — ")}
                  </Text>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <CreditFooter showCredit={settings.show_credit} />
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Cloudflare R2",
})

export default R2SettingsPage
