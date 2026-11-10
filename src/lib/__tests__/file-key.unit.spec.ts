import { buildObjectKey, buildPresignedKey, decodeFileContent, encodeKeyForUrl, publicUrlFor, sanitizeFilePath } from "../file-key"

describe("sanitizeFilePath", () => {
  it("drops leading slashes, traversal and dot segments", () => {
    expect(sanitizeFilePath("/../a/./b/../c.png")).toBe("a/c.png")
    expect(sanitizeFilePath("/a/./b/c.png")).toBe("a/b/c.png")
    expect(sanitizeFilePath("..\\..\\x.jpg")).toBe("x.jpg")
    expect(sanitizeFilePath("....")).toBe("....")
    expect(sanitizeFilePath("..")).toBe("")
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
