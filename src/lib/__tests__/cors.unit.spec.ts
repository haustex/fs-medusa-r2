import type { S3Client } from "@aws-sdk/client-s3"
import { applyCors, checkCors, corsPolicyJson, corsRuleFor, normalizeOrigin } from "../cors"

type Sent = { constructor: { name: string }; input: Record<string, unknown> }

function fakeClient(rules: Record<string, unknown>[] | Error) {
  const sent: Sent[] = []
  const client = {
    send: async (cmd: Sent) => {
      sent.push(cmd)
      if (cmd.constructor.name === "GetBucketCorsCommand") {
        if (rules instanceof Error) throw rules
        return { CORSRules: rules }
      }
      return {}
    },
  } as unknown as S3Client
  return { client, sent }
}

const noCors = Object.assign(new Error("no cors"), { name: "NoSuchCORSConfiguration", $metadata: { httpStatusCode: 404 } })
const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })

describe("normalizeOrigin", () => {
  it("keeps only scheme://host[:port]", () => {
    expect(normalizeOrigin("https://admin.example.com/app/settings?x=1")).toBe("https://admin.example.com")
    expect(normalizeOrigin("http://localhost:9000")).toBe("http://localhost:9000")
    expect(normalizeOrigin("ftp://x")).toBeNull()
    expect(normalizeOrigin("not a url")).toBeNull()
  })
})

describe("checkCors", () => {
  it("reports no policy / forbidden / allowed / missing methods", async () => {
    expect(await checkCors(fakeClient(noCors).client, "b", "https://a")).toEqual({ state: "none" })
    expect((await checkCors(fakeClient(denied).client, "b", "https://a")).state).toBe("forbidden")
    expect(await checkCors(fakeClient([corsRuleFor("https://a") as never]).client, "b", "https://a")).toEqual({ state: "allowed", rules: 1 })
    expect(await checkCors(fakeClient([{ AllowedOrigins: ["https://a"], AllowedMethods: ["GET"] }]).client, "b", "https://a")).toEqual({
      state: "missing",
      rules: 1,
      missingMethods: ["HEAD", "PUT"],
    })
  })
  it("matches wildcard origins", async () => {
    expect((await checkCors(fakeClient([{ AllowedOrigins: ["*"], AllowedMethods: ["GET", "HEAD", "PUT"] }]).client, "b", "https://a")).state).toBe("allowed")
    expect((await checkCors(fakeClient([{ AllowedOrigins: ["https://*.shop.test"], AllowedMethods: ["GET", "HEAD", "PUT"] }]).client, "b", "https://admin.shop.test")).state).toBe("allowed")
    expect((await checkCors(fakeClient([{ AllowedOrigins: ["https://*.shop.test"], AllowedMethods: ["GET", "HEAD", "PUT"] }]).client, "b", "https://evil.test")).state).toBe("missing")
  })
})

describe("applyCors", () => {
  it("adds a rule and keeps the existing ones", async () => {
    const { client, sent } = fakeClient([{ AllowedOrigins: ["https://other"], AllowedMethods: ["GET"] }])
    expect(await applyCors(client, "b", "https://a")).toEqual({ rules: 2, added: true })
    const put = sent.find((c) => c.constructor.name === "PutBucketCorsCommand")!
    const rules = (put.input.CORSConfiguration as { CORSRules: { AllowedOrigins: string[] }[] }).CORSRules
    expect(rules.map((r) => r.AllowedOrigins[0])).toEqual(["https://other", "https://a"])
  })
  it("is idempotent and surfaces a forbidden token", async () => {
    const { client, sent } = fakeClient([corsRuleFor("https://a") as never])
    expect(await applyCors(client, "b", "https://a")).toEqual({ rules: 1, added: false })
    expect(sent.some((c) => c.constructor.name === "PutBucketCorsCommand")).toBe(false)
    await expect(applyCors(fakeClient(denied).client, "b", "https://a")).rejects.toThrow(/Admin Read/)
  })
  it("prints a policy for the dashboard", () => {
    const parsed = JSON.parse(corsPolicyJson("https://a"))
    expect(parsed[0].AllowedOrigins).toEqual(["https://a"])
    expect(parsed[0].AllowedMethods).toEqual(["GET", "HEAD", "PUT"])
  })
})
