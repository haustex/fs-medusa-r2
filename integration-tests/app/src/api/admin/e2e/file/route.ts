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
