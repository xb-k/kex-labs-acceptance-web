/**
 * #134: HTTP surface for the director-template library.
 *
 * `GET` is public (same as the legacy `/api/gemini/script-templates` read);
 * `PUT` / `DELETE` go through `authorizeTaskWrite` (browser same-origin or
 * `X-Web-Token`), matching every other write endpoint.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  isScriptTemplateId,
  listMergedScriptTemplates,
  removeTemplateOverride,
  saveTemplateOverride,
  validateTemplatePatch
} from './script-templates'

export interface ScriptTemplatesRouteDeps {
  dataRoot: string
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
  readBody: (req: IncomingMessage) => Promise<unknown>
  authorize: (req: IncomingMessage) => { ok: true } | { ok: false; status: number; error: string }
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
}

const PUT_PATH = /^\/api\/script-templates\/([a-z0-9_]+)$/
const RESTORE_PATH = /^\/api\/script-templates\/([a-z0-9_]+)\/override$/

function methodNotAllowed(res: ServerResponse, allow: string) {
  res.statusCode = 405
  res.setHeader('Allow', allow)
  res.end()
}

export async function handleScriptTemplatesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: ScriptTemplatesRouteDeps
): Promise<boolean> {
  if (pathname === '/api/script-templates') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return true
    }
    const { items, warnings } = listMergedScriptTemplates(deps.dataRoot, deps.readJson)
    deps.sendJson(res, 200, { items, total: items.length, warnings })
    return true
  }

  const restore = RESTORE_PATH.exec(pathname)
  if (restore) {
    if (req.method !== 'DELETE') {
      methodNotAllowed(res, 'DELETE')
      return true
    }
    const auth = deps.authorize(req)
    if (!auth.ok) {
      deps.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    const id = restore[1]
    if (!isScriptTemplateId(id)) {
      deps.sendJson(res, 404, { error: `template ${id} not found` })
      return true
    }
    const result = removeTemplateOverride({
      dataRoot: deps.dataRoot,
      id,
      readJson: deps.readJson,
      atomicWriteJson: deps.atomicWriteJson
    })
    deps.sendJson(res, 200, { ok: true, item: result.item, removed: result.removed })
    return true
  }

  const put = PUT_PATH.exec(pathname)
  if (put) {
    if (req.method !== 'PUT') {
      methodNotAllowed(res, 'PUT')
      return true
    }
    const auth = deps.authorize(req)
    if (!auth.ok) {
      deps.sendJson(res, auth.status, { error: auth.error })
      return true
    }
    const id = put[1]
    if (!isScriptTemplateId(id)) {
      deps.sendJson(res, 404, { error: `template ${id} not found` })
      return true
    }
    let body: unknown
    try {
      body = await deps.readBody(req)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid body'
      deps.sendJson(res, 400, { error: message })
      return true
    }
    const verdict = validateTemplatePatch(body)
    if (!verdict.ok) {
      deps.sendJson(res, 400, { error: verdict.error })
      return true
    }
    const item = saveTemplateOverride({
      dataRoot: deps.dataRoot,
      id,
      patch: verdict.patch,
      readJson: deps.readJson,
      atomicWriteJson: deps.atomicWriteJson
    })
    deps.sendJson(res, 200, { ok: true, item })
    return true
  }

  return false
}
