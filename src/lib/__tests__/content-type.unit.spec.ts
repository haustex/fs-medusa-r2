import { byExtension, resolveContentType, sniffContentType } from "../content-type"

const bytes = (...b: number[]) => Uint8Array.from(b)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46)
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")])
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0)
const PDF = Uint8Array.from(Buffer.from("%PDF-1.7\n%âãÏÓ", "latin1"))
const SVG = Uint8Array.from(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
const TEXT = Uint8Array.from(Buffer.from("sku,title\n1,Talenan"))

describe("sniffContentType", () => {
  it("recognises common signatures", () => {
    expect(sniffContentType(PNG)).toBe("image/png")
    expect(sniffContentType(JPEG)).toBe("image/jpeg")
    expect(sniffContentType(WEBP)).toBe("image/webp")
    expect(sniffContentType(ZIP)).toBe("application/zip")
    expect(sniffContentType(PDF)).toBe("application/pdf")
    expect(sniffContentType(SVG)).toBe("image/svg+xml")
  })
  it("returns null for plain text and empty input", () => {
    expect(sniffContentType(TEXT)).toBeNull()
    expect(sniffContentType(new Uint8Array())).toBeNull()
  })
})

describe("resolveContentType", () => {
  it("prefers the bytes over what the client declared", () => {
    expect(resolveContentType(PNG, "application/octet-stream", "photo.bin")).toBe("image/png")
    expect(resolveContentType(PNG, "image/jpeg", "photo.jpg")).toBe("image/png")
  })
  it("keeps a specific declared type for zip containers (docx, xlsx)", () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    expect(resolveContentType(ZIP, docx, "a.docx")).toBe(docx)
    expect(resolveContentType(ZIP, "application/octet-stream", "a.zip")).toBe("application/zip")
  })
  it("falls back to the declared type, then the extension, then octet-stream", () => {
    expect(resolveContentType(TEXT, "text/csv; charset=utf-8", "products.csv")).toBe("text/csv")
    expect(resolveContentType(TEXT, "application/octet-stream", "products.csv")).toBe("text/csv")
    expect(resolveContentType(TEXT, "", "products.CSV")).toBe("text/csv")
    expect(resolveContentType(TEXT, "not a type", "blob")).toBe("application/octet-stream")
    expect(byExtension("x.unknownext")).toBeNull()
  })
})
