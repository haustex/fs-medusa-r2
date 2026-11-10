import { buildObjectKey, buildPresignedKey, decodeFileContent, encodeKeyForUrl, publicUrlFor, repairFilename, sanitizeFilePath } from "../file-key"

describe("sanitizeFilePath", () => {
  it("drops leading slashes, traversal and dot segments", () => {
    expect(sanitizeFilePath("/../a/./b/../c.png")).toBe("a/c.png")
    expect(sanitizeFilePath("/a/./b/c.png")).toBe("a/b/c.png")
    expect(sanitizeFilePath("..\\..\\x.jpg")).toBe("x.jpg")
    expect(sanitizeFilePath("....")).toBe("....")
    expect(sanitizeFilePath("..")).toBe("")
  })
})

describe("repairFilename", () => {
  it("re-decodes UTF-8 names that busboy decoded as latin1", () => {
    const mojibake = Buffer.from("Talenan – 30×20 ñ 日本.png", "utf8").toString("latin1")
    expect(repairFilename(mojibake)).toBe("Talenan – 30×20 ñ 日本.png")
    expect(sanitizeFilePath(mojibake)).toBe("Talenan – 30×20 ñ 日本.png")
  })
  it("leaves ASCII, real latin1 and already-correct unicode alone", () => {
    expect(repairFilename("plain.png")).toBe("plain.png")
    expect(repairFilename("café.png")).toBe("café.png")
    expect(repairFilename("日本.png")).toBe("日本.png")
  })
})

describe("buildObjectKey", () => {
  it("adds the prefix, keeps the directory and puts the id before the extension", () => {
    expect(buildObjectKey("medusa/", "products/talenan jati.PNG", "01ABC")).toBe("medusa/products/talenan jati-01ABC.PNG")
    expect(buildObjectKey("", "a.webp", "ID")).toBe("a-ID.webp")
    expect(buildObjectKey("", "noext", "ID")).toBe("noext-ID")
  })
  it("refuses names that sanitize to nothing", () => {
    expect(buildObjectKey("p/", "../..")).toBeNull()
    expect(buildPresignedKey("p/", "/")).toBeNull()
  })
  it("presigned keys keep the caller's name", () => {
    expect(buildPresignedKey("p/", "/imports/products.csv")).toBe("p/imports/products.csv")
  })
})

describe("urls", () => {
  it("encodes each segment and joins with the public url", () => {
    expect(encodeKeyForUrl("a b/c#d.png")).toBe("a%20b/c%23d.png")
    expect(publicUrlFor("https://cdn.x", "a b.png")).toBe("https://cdn.x/a%20b.png")
    expect(publicUrlFor(null, "a.png")).toBeNull()
  })
  it("applies a URL template when one is set", () => {
    const tpl = "{public_url}/cdn-cgi/image/format=auto,quality=85/{key}"
    expect(publicUrlFor("https://cdn.x", "m/a b.png", tpl)).toBe("https://cdn.x/cdn-cgi/image/format=auto,quality=85/m/a%20b.png")
    expect(publicUrlFor("https://cdn.x", "a.png", "https://img.x/{key}")).toBe("https://img.x/a.png")
    expect(publicUrlFor("https://cdn.x", "a.png", "no-key-placeholder")).toBe("https://cdn.x/a.png")
    expect(publicUrlFor(null, "a.png", tpl)).toBeNull()
  })
})

describe("decodeFileContent", () => {
  it("decodes base64, utf8 text and binary strings", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    expect(decodeFileContent(png.toString("base64"), "image/png")).toEqual(png)
    expect(decodeFileContent(png.toString("binary"), "image/png")).toEqual(png)
    expect(decodeFileContent("nama,harga\nTalenan,150000", "text/csv").toString("utf8")).toBe("nama,harga\nTalenan,150000")
    expect(decodeFileContent("é", "text/plain").toString("utf8")).toBe("é")
  })
})
