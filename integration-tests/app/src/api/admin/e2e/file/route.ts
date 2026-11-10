import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { IFileModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * E2E helper: exercise the File Module directly (private uploads, presigned
 * download URLs, buffers), which the public Admin routes do not expose.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const body = req.body as { filename: string; content: string; mimeType?: string; access?: "public" | "private" }
  const files: IFileModuleService = req.scope.resolve(Modules.FILE)
  const [file] = await files.createFiles([
    { filename: body.filename, content: body.content, mimeType: body.mimeType ?? "text/plain", access: body.access ?? "public" },
  ])
  res.json({ file })
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const key = String(req.query.key)
  const files: IFileModuleService = req.scope.resolve(Modules.FILE)
  const { url } = await files.retrieveFile(key)
  const buffer = await files.getAsBuffer(key)
  res.json({ url, content: buffer.toString("utf8") })
}

export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const files: IFileModuleService = req.scope.resolve(Modules.FILE)
  await files.deleteFiles(String(req.query.key))
  res.json({ ok: true })
}

/** Streams the raw request body into the provider (multipart upload, no content-length needed). */
export async function PUT(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const files: IFileModuleService = req.scope.resolve(Modules.FILE)
  const filename = String(req.query.filename)
  const mimeType = req.query.mimeType ? String(req.query.mimeType) : undefined
  const access = (req.query.access as "public" | "private" | undefined) ?? "public"
  const { writeStream, promise, fileKey } = await files.getUploadStream({ filename, mimeType, access })
  req.pipe(writeStream)
  try {
    const file = await promise
    res.json({ file, fileKey })
  } catch (e) {
    const err = e as { type?: string; message?: string }
    res.status(400).json({ type: err.type, message: err.message })
  }
}
