/**
 * Agent / skill / profile library backend (issue #88a).
 *
 * Storage is a plain filesystem tree under `<DATA_ROOT>/agents`:
 *
 *   skills|agents|profiles/<id>/
 *     meta.json                 metadata + immutable version list + active pointer
 *     content.md|content.json   materialised copy of the active version
 *     versions/v<n>.md|.json    immutable version bodies
 *     changelog.jsonl           append-only change log
 *
 * Versions are never rewritten: a PUT appends `v<n+1>`, a rollback only moves
 * `meta.active_version`. Imported/edited content is stored as text and never
 * executed or rendered by this module. Reads are public; writes need the exact
 * `X-Web-Token` or a same-origin request (same rule as `studio.ts`).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizedForWrite } from './studio'

export type AgentType = 'skill' | 'agent' | 'profile'

/** #109: host / project bucket for the library grouping view. */
export type AgentHost = 'macbook' | 'studio' | '未指定'
export type AgentProject = 'kex-labs-video' | 'agent-memory' | 'lofa' | '通用' | '未分组'

const AGENT_HOSTS: AgentHost[] = ['macbook', 'studio', '未指定']
const AGENT_PROJECTS: AgentProject[] = ['kex-labs-video', 'agent-memory', 'lofa', '通用', '未分组']

interface ClassifyAgentEntry {
  host?: AgentHost
  project?: AgentProject
  skills?: string[]
}

interface ClassifyDoc {
  agents: Record<string, ClassifyAgentEntry>
  skills: Record<string, { project?: AgentProject }>
}

interface VersionEntry {
  version: number
  sha256: string
  created_at: string
  message: string
}

interface AgentSource {
  kind: 'local' | 'import' | 'edit'
  url: string | null
  repo: string | null
  commit: string | null
  license: string
  sha256: string
  imported_at?: string
}

interface AgentMeta {
  id: string
  type: AgentType
  name: string
  description: string
  namespace: 'seed' | 'import' | 'user'
  active: boolean
  active_version: number
  source: AgentSource
  created_at: string
  updated_at: string
  versions: VersionEntry[]
  // #109 taxonomy. Stored meta wins; empty fields fall back to classify.json.
  host?: AgentHost
  project?: AgentProject
  skills?: string[]
}

/** Everything this module needs from api.ts (same shape as StudioContext). */
export interface AgentsContext {
  dataRoot: string
  webToken: string | null
  isSameOrigin: (req: IncomingMessage) => boolean
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readJson: (file: string) => any
  atomicWriteJson: (file: string, value: unknown) => void
}

const AGENT_TYPES: AgentType[] = ['skill', 'agent', 'profile']
const TYPE_DIR: Record<AgentType, string> = { skill: 'skills', agent: 'agents', profile: 'profiles' }
const TYPE_EXT: Record<AgentType, string> = { skill: 'md', agent: 'md', profile: 'json' }
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const MAX_CONTENT_BYTES = 256 * 1024
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_DIFF_LINES = 512
const FETCH_TIMEOUT_MS = 10_000
const ALLOWED_HOSTS = new Set(['raw.githubusercontent.com', 'gist.githubusercontent.com', 'cdn.jsdelivr.net'])

/** Seed manifest shipped inside the image (`COPY seed-agents ./seed-agents`). */
const SEED_ROOT = process.env.WEB_SEED_ROOT
  ? path.resolve(process.env.WEB_SEED_ROOT)
  : path.resolve(process.cwd(), 'seed-agents')

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class AgentsError extends Error {
  status: number
  code: string
  reason: string

  constructor(status: number, code: string, reason: string) {
    super(`${code}: ${reason}`)
    this.status = status
    this.code = code
    this.reason = reason
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nowIso(): string {
  return new Date().toISOString()
}

function sha256(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (AGENT_TYPES as string[]).includes(value)
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// ---------------------------------------------------------------------------
// #109 taxonomy: host / project / default skill bindings
// ---------------------------------------------------------------------------

function isAgentHost(value: unknown): value is AgentHost {
  return typeof value === 'string' && (AGENT_HOSTS as string[]).includes(value)
}

function isAgentProject(value: unknown): value is AgentProject {
  return typeof value === 'string' && (AGENT_PROJECTS as string[]).includes(value)
}

/**
 * classify.json ships next to the seed manifest. It is a read-only default:
 * anything already stored in a meta.json (host/project/skills) wins, so user
 * edits are never overwritten on read. A missing/broken file degrades to the
 * "未分组 / 未指定" buckets instead of failing the whole library.
 */
function readClassify(): ClassifyDoc {
  const file = path.join(SEED_ROOT, 'classify.json')
  let doc: unknown
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { agents: {}, skills: {} }
  }
  if (!isRecord(doc)) return { agents: {}, skills: {} }
  const agents: Record<string, ClassifyAgentEntry> = {}
  if (isRecord(doc.agents)) {
    for (const [id, entry] of Object.entries(doc.agents)) {
      if (!isRecord(entry)) continue
      const host = isAgentHost(entry.host) ? entry.host : undefined
      const project = isAgentProject(entry.project) ? entry.project : undefined
      const skills = Array.isArray(entry.skills)
        ? entry.skills.filter((value): value is string => typeof value === 'string' && ID_RE.test(value))
        : undefined
      agents[id] = { host, project, skills }
    }
  }
  const skills: Record<string, { project?: AgentProject }> = {}
  if (isRecord(doc.skills)) {
    for (const [id, entry] of Object.entries(doc.skills)) {
      if (!isRecord(entry)) continue
      skills[id] = { project: isAgentProject(entry.project) ? entry.project : undefined }
    }
  }
  return { agents, skills }
}

function resolvedProject(meta: AgentMeta, classify: ClassifyDoc): AgentProject {
  if (isAgentProject(meta.project)) return meta.project
  if (meta.type === 'skill') return classify.skills[meta.id]?.project ?? '未分组'
  return classify.agents[meta.id]?.project ?? '未分组'
}

function resolvedHost(meta: AgentMeta, classify: ClassifyDoc): AgentHost {
  if (isAgentHost(meta.host)) return meta.host
  if (meta.type !== 'agent') return '未指定'
  return classify.agents[meta.id]?.host ?? '未指定'
}

function resolvedSkills(meta: AgentMeta, classify: ClassifyDoc): string[] {
  if (meta.type !== 'agent') return []
  const stored = Array.isArray(meta.skills)
    ? meta.skills.filter((value): value is string => typeof value === 'string' && ID_RE.test(value))
    : null
  if (stored) return stored
  return classify.agents[meta.id]?.skills ?? []
}

/** Meta + taxonomy fields, returned by list/detail/write responses. */
function withTaxonomy(meta: AgentMeta, classify: ClassifyDoc): AgentMeta {
  return {
    ...meta,
    host: resolvedHost(meta, classify),
    project: resolvedProject(meta, classify),
    skills: resolvedSkills(meta, classify)
  }
}

function atomicWriteText(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function agentsRoot(ctx: AgentsContext): string {
  return path.join(ctx.dataRoot, 'agents')
}

function itemDir(ctx: AgentsContext, type: AgentType, id: string): string {
  return path.join(agentsRoot(ctx), TYPE_DIR[type], id)
}

function metaFile(ctx: AgentsContext, type: AgentType, id: string): string {
  return path.join(itemDir(ctx, type, id), 'meta.json')
}

function contentFile(ctx: AgentsContext, type: AgentType, id: string): string {
  return path.join(itemDir(ctx, type, id), `content.${TYPE_EXT[type]}`)
}

function versionFile(ctx: AgentsContext, type: AgentType, id: string, version: number): string {
  return path.join(itemDir(ctx, type, id), 'versions', `v${version}.${TYPE_EXT[type]}`)
}

function changelogFile(ctx: AgentsContext, type: AgentType, id: string): string {
  return path.join(itemDir(ctx, type, id), 'changelog.jsonl')
}

// ---------------------------------------------------------------------------
// Metadata / content access
// ---------------------------------------------------------------------------

function readMeta(ctx: AgentsContext, type: AgentType, id: string): AgentMeta | null {
  if (!ID_RE.test(id)) return null
  const doc = ctx.readJson(metaFile(ctx, type, id))
  if (!isRecord(doc)) return null
  if (doc.id !== id || doc.type !== type) return null
  if (!Array.isArray(doc.versions) || typeof doc.active_version !== 'number') return null
  return doc as unknown as AgentMeta
}

function readVersion(ctx: AgentsContext, type: AgentType, id: string, version: number): string | null {
  try {
    return fs.readFileSync(versionFile(ctx, type, id, version), 'utf8')
  } catch {
    return null
  }
}

function readActiveContent(ctx: AgentsContext, meta: AgentMeta): string | null {
  return readVersion(ctx, meta.type, meta.id, meta.active_version)
}

function listMetas(ctx: AgentsContext, type: AgentType): AgentMeta[] {
  const dir = path.join(agentsRoot(ctx), TYPE_DIR[type])
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const metas: AgentMeta[] = []
  for (const name of names.sort()) {
    const meta = readMeta(ctx, type, name)
    if (meta) metas.push(meta)
  }
  return metas
}

function summary(meta: AgentMeta, classify: ClassifyDoc) {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    description: meta.description,
    namespace: meta.namespace,
    active: meta.active,
    active_version: meta.active_version,
    source: meta.source,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    versions_count: meta.versions.length,
    host: resolvedHost(meta, classify),
    project: resolvedProject(meta, classify),
    skills: resolvedSkills(meta, classify)
  }
}

function appendChangelog(ctx: AgentsContext, meta: AgentMeta, action: string, version: number, message: string) {
  const line = JSON.stringify({ at: nowIso(), action, version, message }) + '\n'
  fs.mkdirSync(itemDir(ctx, meta.type, meta.id), { recursive: true })
  fs.appendFileSync(changelogFile(ctx, meta.type, meta.id), line, 'utf8')
}

/** Writes the immutable version body, materialised content and metadata. */
function commitVersion(ctx: AgentsContext, meta: AgentMeta, content: string, message: string) {
  const version = Math.max(...meta.versions.map((v) => v.version)) + 1
  const hash = sha256(content)
  const stamp = nowIso()
  atomicWriteText(versionFile(ctx, meta.type, meta.id, version), content)
  atomicWriteText(contentFile(ctx, meta.type, meta.id), content)
  meta.active_version = version
  meta.versions.push({ version, sha256: hash, created_at: stamp, message })
  meta.source.kind = 'edit'
  meta.source.sha256 = hash
  meta.updated_at = stamp
  appendChangelog(ctx, meta, 'edit', version, message)
  ctx.atomicWriteJson(metaFile(ctx, meta.type, meta.id), meta)
  return version
}

// ---------------------------------------------------------------------------
// Content validation (format only — never executed)
// ---------------------------------------------------------------------------

function frontmatterOf(text: string): Record<string, string> | null {
  const body = text.replace(/^\uFEFF/, '')
  const lines = body.split('\n')
  if (lines[0] !== '---') return null
  const attrs: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return attrs
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    attrs[match[1]] = value
  }
  return null
}

/**
 * Type check used by both import (strict: frontmatter name+description, JSON
 * name+label) and edit (same content family, but seed definitions may lack
 * `name`, so edit requires a valid frontmatter block / JSON object only).
 */
function validateContent(type: AgentType, text: string, strict: boolean): void {
  if (type === 'profile') {
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      throw new AgentsError(422, 'invalid_content', 'profile 内容必须是 JSON 对象')
    }
    if (!isRecord(doc)) throw new AgentsError(422, 'invalid_content', 'profile 内容必须是 JSON 对象')
    const required = strict ? ['name', 'label'] : ['label']
    for (const key of required) {
      if (typeof doc[key] !== 'string' || !(doc[key] as string).trim()) {
        throw new AgentsError(422, 'invalid_content', `profile JSON 缺少 ${key}`)
      }
    }
    return
  }
  const attrs = frontmatterOf(text)
  if (!attrs) throw new AgentsError(422, 'invalid_content', `${type} 内容缺少 YAML frontmatter`)
  if (!attrs.description || !attrs.description.trim()) {
    throw new AgentsError(422, 'invalid_content', `${type} frontmatter 缺少 description`)
  }
  if (strict && (!attrs.name || !attrs.name.trim())) {
    throw new AgentsError(422, 'invalid_content', `${type} frontmatter 缺少 name`)
  }
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['openai_key', /\bsk-[A-Za-z0-9]{12,}/],
  ['github_token', /\bghp_[A-Za-z0-9]{20,}/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{12,}/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['password_literal', /password\s*=/i]
]

function assertNoSecrets(text: string): void {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new AgentsError(422, 'secret_detected', `内容命中密钥特征 ${name}，已拒绝`)
    }
  }
}

// ---------------------------------------------------------------------------
// Import (GitHub raw allowlist)
// ---------------------------------------------------------------------------

function assertAllowedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AgentsError(422, 'url_not_allowed', 'URL 无法解析')
  }
  if (url.protocol !== 'https:') {
    throw new AgentsError(422, 'url_not_allowed', '仅允许 https')
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new AgentsError(422, 'url_not_allowed', `host 不在 allowlist: ${url.hostname}`)
  }
  if (url.hostname === 'cdn.jsdelivr.net' && !url.pathname.startsWith('/gh/')) {
    throw new AgentsError(422, 'url_not_allowed', 'jsdelivr 仅允许 /gh/ 路径')
  }
  return url
}

function provenanceFromUrl(raw: string): { repo: string | null; commit: string | null } {
  const url = new URL(raw)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.hostname === 'raw.githubusercontent.com' && parts.length >= 3) {
    const ref = parts[2]
    return {
      repo: `${parts[0]}/${parts[1]}`,
      commit: /^[0-9a-f]{40}$/i.test(ref) ? ref : null
    }
  }
  if (url.hostname === 'cdn.jsdelivr.net' && parts[0] === 'gh' && parts.length >= 3) {
    const [owner, repoRef] = [parts[1], parts[2]]
    const at = repoRef.indexOf('@')
    const repo = at >= 0 ? repoRef.slice(0, at) : repoRef
    const ref = at >= 0 ? repoRef.slice(at + 1) : ''
    return {
      repo: `${owner}/${repo}`,
      commit: /^[0-9a-f]{40}$/i.test(ref) ? ref : null
    }
  }
  if (url.hostname === 'gist.githubusercontent.com' && parts.length >= 2) {
    return { repo: `${parts[0]}/gist:${parts[1]}`, commit: null }
  }
  return { repo: null, commit: null }
}

async function fetchSource(raw: string): Promise<{ text: string; contentType: string; finalUrl: string }> {
  assertAllowedUrl(raw)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(raw, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'kex-acceptance-web/agents' }
    })
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ?? cause?.message ?? (err as Error).message
    throw new AgentsError(
      aborted ? 504 : 502,
      aborted ? 'fetch_timeout' : 'fetch_failed',
      aborted ? '上游 10s 超时' : `上游请求失败: ${detail}`
    )
  } finally {
    clearTimeout(timer)
  }
  // A redirect may not smuggle us onto a non-allowlisted host.
  assertAllowedUrl(response.url || raw)
  if (!response.ok) {
    throw new AgentsError(502, 'fetch_failed', `上游返回 ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_CONTENT_BYTES) {
    throw new AgentsError(413, 'content_too_large', `内容超过 ${MAX_CONTENT_BYTES} 字节`)
  }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const allowedType =
    contentType === '' ||
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/octet-stream'
  if (!allowedType) {
    throw new AgentsError(422, 'unsupported_content_type', `不支持的内容类型 ${contentType}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_CONTENT_BYTES) {
    throw new AgentsError(413, 'content_too_large', `内容超过 ${MAX_CONTENT_BYTES} 字节`)
  }
  return { text: buffer.toString('utf8'), contentType, finalUrl: response.url || raw }
}

function frontmatterName(type: AgentType, text: string): string | null {
  if (type === 'profile') {
    try {
      const doc = JSON.parse(text)
      return isRecord(doc) && typeof doc.name === 'string' ? doc.name : null
    } catch {
      return null
    }
  }
  const attrs = frontmatterOf(text)
  return attrs?.name ?? null
}

// ---------------------------------------------------------------------------
// Line diff (LCS, both sides capped at 512 lines)
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function unifiedDiff(id: string, from: number, to: number, before: string, after: string): string {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    throw new AgentsError(422, 'diff_too_large', `单侧超过 ${MAX_DIFF_LINES} 行`)
  }
  const width = b.length + 1
  const dp = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const out = [`--- a/${id}@v${from}`, `+++ b/${id}@v${to}`, `@@ -1,${a.length} +1,${b.length} @@`]
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push(`-${a[i]}`)
      i++
    } else {
      out.push(`+${b[j]}`)
      j++
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`)
  while (j < b.length) out.push(`+${b[j++]}`)
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function requireWrite(ctx: AgentsContext, req: IncomingMessage, res: ServerResponse): boolean {
  return authorizedForWrite(ctx.webToken, ctx.isSameOrigin, req, res, ctx.sendJson)
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new AgentsError(413, 'body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) throw new AgentsError(400, 'invalid_json', '请求体为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new AgentsError(400, 'invalid_json', '请求体不是合法 JSON')
  }
}

function parseVersion(value: unknown): number {
  const version = typeof value === 'string' ? Number(value) : value
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new AgentsError(400, 'invalid_version', '版本号必须是正整数')
  }
  return version
}

function listRoute(ctx: AgentsContext, url: URL, res: ServerResponse) {
  const typeParam = url.searchParams.get('type')
  if (typeParam !== null && !isAgentType(typeParam)) {
    throw new AgentsError(400, 'invalid_type', `未知类型 ${typeParam}`)
  }
  const includeInactive = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('include_inactive') ?? '').toLowerCase()
  )
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()

  const classify = readClassify()
  const counts: Record<AgentType, number> = { skill: 0, agent: 0, profile: 0 }
  const items: ReturnType<typeof summary>[] = []
  for (const type of AGENT_TYPES) {
    for (const meta of listMetas(ctx, type)) {
      if (!meta.active && !includeInactive) continue
      // Counts describe the whole visible library; `type`/`q` only filter items.
      counts[type]++
      if (typeParam && type !== typeParam) continue
      if (query) {
        const haystack = `${meta.id} ${meta.name} ${meta.description}`.toLowerCase()
        if (!haystack.includes(query)) continue
      }
      items.push(summary(meta, classify))
    }
  }
  ctx.sendJson(res, 200, { items, counts })
}

function detailRoute(ctx: AgentsContext, type: AgentType, id: string, res: ServerResponse) {
  const meta = readMeta(ctx, type, id)
  if (!meta) throw new AgentsError(404, 'not_found', `${type} ${id} 不存在`)
  const content = readActiveContent(ctx, meta)
  if (content === null) throw new AgentsError(404, 'content_missing', `active v${meta.active_version} 内容缺失`)
  const classify = readClassify()
  // Only same-project skills may be bound; the list is computed server-side so
  // it stays correct when the client list is filtered by search/type.
  const bindable_skills =
    type === 'agent'
      ? listMetas(ctx, 'skill')
          .filter((skill) => skill.active && resolvedProject(skill, classify) === resolvedProject(meta, classify))
          .map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            project: resolvedProject(skill, classify)
          }))
      : []
  ctx.sendJson(res, 200, { meta: withTaxonomy(meta, classify), content, bindable_skills })
}

async function importRoute(ctx: AgentsContext, req: IncomingMessage, res: ServerResponse) {
  if (!requireWrite(ctx, req, res)) return
  const body = await readJsonBody(req)
  if (!isRecord(body)) throw new AgentsError(400, 'invalid_body', '请求体必须是 JSON 对象')
  const { type, url: rawUrl } = body
  if (!isAgentType(type)) throw new AgentsError(400, 'invalid_type', 'type 必须是 skill/agent/profile')
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new AgentsError(400, 'invalid_url', 'url 必须是非空字符串')
  }

  const fetched = await fetchSource(rawUrl.trim())
  assertNoSecrets(fetched.text)
  validateContent(type, fetched.text, true)

  const license =
    (typeof body.license === 'string' ? body.license.trim() : '') || declaredLicense(type, fetched.text).trim()
  if (!license) {
    throw new AgentsError(422, 'license_required', '缺少 license，拒绝导入')
  }

  const requestedId = typeof body.id === 'string' ? body.id.trim() : ''
  const derived = frontmatterName(type, fetched.text)
  const id = requestedId || (derived ? slug(derived) : '')
  if (!ID_RE.test(id)) {
    throw new AgentsError(400, 'invalid_id', `id 不合法: ${id || '(empty)'}`)
  }
  if (readMeta(ctx, type, id)) {
    throw new AgentsError(409, 'already_exists', `${type} ${id} 已存在，请改用 PUT 编辑`)
  }

  const fromUrl = provenanceFromUrl(fetched.finalUrl)
  const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : fromUrl.repo
  const commit = typeof body.commit === 'string' && body.commit.trim() ? body.commit.trim() : fromUrl.commit
  const stamp = nowIso()
  const hash = sha256(fetched.text)
  const meta: AgentMeta = {
    id,
    type,
    name: derived ?? id,
    description: metaDescription(type, fetched.text),
    namespace: 'import',
    active: true,
    active_version: 1,
    source: {
      kind: 'import',
      url: fetched.finalUrl,
      repo,
      commit,
      license,
      sha256: hash,
      imported_at: stamp
    },
    created_at: stamp,
    updated_at: stamp,
    versions: [{ version: 1, sha256: hash, created_at: stamp, message: 'import' }]
  }
  atomicWriteText(versionFile(ctx, type, id, 1), fetched.text)
  atomicWriteText(contentFile(ctx, type, id), fetched.text)
  appendChangelog(ctx, meta, 'import', 1, `import ${repo ?? fetched.finalUrl}`)
  ctx.atomicWriteJson(metaFile(ctx, type, id), meta)
  ctx.sendJson(res, 201, { meta })
}

function declaredLicense(type: AgentType, text: string): string {
  if (type === 'profile') {
    const doc = JSON.parse(text)
    return isRecord(doc) && typeof doc.license === 'string' ? doc.license : ''
  }
  return frontmatterOf(text)?.license ?? ''
}

function metaDescription(type: AgentType, text: string): string {
  if (type === 'profile') {
    try {
      const doc = JSON.parse(text)
      return isRecord(doc) && typeof doc.label === 'string' ? doc.label : ''
    } catch {
      return ''
    }
  }
  return frontmatterOf(text)?.description ?? ''
}

async function putRoute(ctx: AgentsContext, req: IncomingMessage, res: ServerResponse, type: AgentType, id: string) {
  if (!requireWrite(ctx, req, res)) return
  const meta = readMeta(ctx, type, id)
  if (!meta) throw new AgentsError(404, 'not_found', `${type} ${id} 不存在`)
  const body = await readJsonBody(req)
  if (!isRecord(body) || typeof body.content !== 'string') {
    throw new AgentsError(400, 'invalid_body', 'content 必须是字符串')
  }
  const content = body.content
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new AgentsError(413, 'content_too_large', `内容超过 ${MAX_CONTENT_BYTES} 字节`)
  }
  assertNoSecrets(content)
  validateContent(type, content, false)
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'edit'
  const version = commitVersion(ctx, meta, content, message)
  ctx.sendJson(res, 200, { meta, version })
}

async function rollbackRoute(
  ctx: AgentsContext,
  req: IncomingMessage,
  res: ServerResponse,
  type: AgentType,
  id: string
) {
  if (!requireWrite(ctx, req, res)) return
  const meta = readMeta(ctx, type, id)
  if (!meta) throw new AgentsError(404, 'not_found', `${type} ${id} 不存在`)
  const body = await readJsonBody(req)
  if (!isRecord(body)) throw new AgentsError(400, 'invalid_body', '请求体必须是 JSON 对象')
  const version = parseVersion(body.version)
  if (!meta.versions.some((entry) => entry.version === version)) {
    throw new AgentsError(404, 'version_not_found', `v${version} 不存在`)
  }
  const content = readVersion(ctx, type, id, version)
  if (content === null) throw new AgentsError(404, 'version_not_found', `v${version} 内容缺失`)
  atomicWriteText(contentFile(ctx, type, id), content)
  meta.active_version = version
  meta.source.sha256 = sha256(content)
  meta.updated_at = nowIso()
  appendChangelog(ctx, meta, 'rollback', version, `rollback to v${version}`)
  ctx.atomicWriteJson(metaFile(ctx, type, id), meta)
  ctx.sendJson(res, 200, { meta })
}

async function toggleRoute(ctx: AgentsContext, req: IncomingMessage, res: ServerResponse, type: AgentType, id: string) {
  if (!requireWrite(ctx, req, res)) return
  const meta = readMeta(ctx, type, id)
  if (!meta) throw new AgentsError(404, 'not_found', `${type} ${id} 不存在`)
  const body = await readJsonBody(req)
  if (!isRecord(body) || typeof body.active !== 'boolean') {
    throw new AgentsError(400, 'invalid_body', 'active 必须是布尔值')
  }
  meta.active = body.active
  meta.updated_at = nowIso()
  appendChangelog(ctx, meta, 'toggle', meta.active_version, `active=${meta.active}`)
  ctx.atomicWriteJson(metaFile(ctx, type, id), meta)
  ctx.sendJson(res, 200, { meta })
}

function diffRoute(ctx: AgentsContext, url: URL, res: ServerResponse, type: AgentType, id: string) {
  const meta = readMeta(ctx, type, id)
  if (!meta) throw new AgentsError(404, 'not_found', `${type} ${id} 不存在`)
  const from = parseVersion(url.searchParams.get('from'))
  const to = parseVersion(url.searchParams.get('to'))
  const before = readVersion(ctx, type, id, from)
  const after = readVersion(ctx, type, id, to)
  if (before === null) throw new AgentsError(404, 'version_not_found', `v${from} 不存在`)
  if (after === null) throw new AgentsError(404, 'version_not_found', `v${to} 不存在`)
  ctx.sendJson(res, 200, { unified: unifiedDiff(id, from, to, before, after) })
}

function exportRoute(ctx: AgentsContext, res: ServerResponse, type: AgentType, id: string) {
  const meta = readMeta(ctx, type, id)
  if (!meta) throw new AgentsError(404, 'not_found', `${type} ${id} 不存在`)
  const version = meta.versions.find((entry) => entry.version === meta.active_version)
  const content = readActiveContent(ctx, meta)
  if (content === null || !version) {
    throw new AgentsError(404, 'content_missing', `active v${meta.active_version} 内容缺失`)
  }
  const ext = TYPE_EXT[type]
  res.statusCode = 200
  res.setHeader('Content-Type', type === 'profile' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${id}.${ext}"`)
  res.setHeader('X-Content-SHA256', version.sha256)
  res.setHeader('Cache-Control', 'no-store')
  res.end(content)
}

/**
 * `POST /api/agents/agent/<id>/skills` (#109).
 *
 * Body: `{ skills: string[] }` — ids of skills in the same project as the
 * agent. The binding only stores ids in meta.json; skill bodies are never
 * inlined or executed here.
 */
async function skillsRoute(ctx: AgentsContext, req: IncomingMessage, res: ServerResponse, id: string) {
  if (!requireWrite(ctx, req, res)) return
  const meta = readMeta(ctx, 'agent', id)
  if (!meta) throw new AgentsError(404, 'not_found', `agent ${id} 不存在`)
  const body = await readJsonBody(req)
  if (!isRecord(body) || !Array.isArray(body.skills)) {
    throw new AgentsError(400, 'invalid_body', 'skills 必须是字符串数组')
  }
  const classify = readClassify()
  const agentProject = resolvedProject(meta, classify)
  const ids: string[] = []
  for (const value of body.skills) {
    if (typeof value !== 'string' || !ID_RE.test(value)) {
      throw new AgentsError(400, 'invalid_skill', `技能 id 不合法: ${String(value)}`)
    }
    if (!ids.includes(value)) ids.push(value)
  }
  if (ids.length > 64) throw new AgentsError(400, 'invalid_body', '单个 agent 最多绑定 64 个技能')
  for (const skillId of ids) {
    const skill = readMeta(ctx, 'skill', skillId)
    if (!skill) throw new AgentsError(400, 'unknown_skill', `技能 ${skillId} 不存在`)
    if (resolvedProject(skill, classify) !== agentProject) {
      throw new AgentsError(400, 'cross_project_skill', `技能 ${skillId} 不属于项目 ${agentProject}`)
    }
  }
  const updated: AgentMeta = { ...meta, skills: ids, updated_at: nowIso() }
  appendChangelog(ctx, updated, 'skills', meta.active_version, ids.length ? ids.join(',') : '(none)')
  ctx.atomicWriteJson(metaFile(ctx, 'agent', id), updated)
  ctx.sendJson(res, 200, { meta: summary(updated, classify) })
}

interface SeedEntry {
  type: AgentType
  id: string
  file: string
  source?: Partial<AgentSource>
}

function readSeedManifest(): SeedEntry[] {
  const file = path.join(SEED_ROOT, 'manifest.json')
  let doc: unknown
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new AgentsError(500, 'seed_manifest_missing', `无法读取 ${file}: ${(err as Error).message}`)
  }
  if (!Array.isArray(doc)) throw new AgentsError(500, 'seed_manifest_missing', 'manifest 必须是数组')
  return doc.map((entry, index) => {
    if (!isRecord(entry)) throw new AgentsError(500, 'seed_manifest_invalid', `manifest[${index}] 不是对象`)
    const { type, id, file: rel } = entry
    if (!isAgentType(type)) throw new AgentsError(500, 'seed_manifest_invalid', `manifest[${index}] type 非法`)
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new AgentsError(500, 'seed_manifest_invalid', `manifest[${index}] id 非法`)
    }
    if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split('/').includes('..')) {
      throw new AgentsError(500, 'seed_manifest_invalid', `manifest[${index}] file 非法`)
    }
    const source = isRecord(entry.source) ? (entry.source as unknown as Partial<AgentSource>) : {}
    return { type, id, file: rel, source }
  })
}

function seedRoute(ctx: AgentsContext, req: IncomingMessage, res: ServerResponse) {
  if (!requireWrite(ctx, req, res)) return
  const entries = readSeedManifest()
  const created: Record<AgentType, number> = { skill: 0, agent: 0, profile: 0 }
  const skipped: Record<AgentType, number> = { skill: 0, agent: 0, profile: 0 }
  for (const entry of entries) {
    if (readMeta(ctx, entry.type, entry.id)) {
      skipped[entry.type]++
      continue
    }
    let text: string
    try {
      text = fs.readFileSync(path.join(SEED_ROOT, entry.file), 'utf8')
    } catch (err) {
      throw new AgentsError(500, 'seed_file_missing', `${entry.file}: ${(err as Error).message}`)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTENT_BYTES) {
      throw new AgentsError(500, 'seed_file_too_large', `${entry.file} 超过 ${MAX_CONTENT_BYTES} 字节`)
    }
    const stamp = nowIso()
    const hash = sha256(text)
    const meta: AgentMeta = {
      id: entry.id,
      type: entry.type,
      name: seedName(entry, text),
      description: metaDescription(entry.type, text),
      namespace: 'seed',
      active: true,
      active_version: 1,
      source: {
        kind:
          entry.source?.kind === 'import' || entry.source?.kind === 'edit' || entry.source?.kind === 'local'
            ? entry.source.kind
            : 'local',
        url: typeof entry.source?.url === 'string' ? entry.source.url : null,
        repo: typeof entry.source?.repo === 'string' ? entry.source.repo : null,
        commit: typeof entry.source?.commit === 'string' ? entry.source.commit : null,
        license: typeof entry.source?.license === 'string' ? entry.source.license : 'internal',
        sha256: hash
      },
      created_at: stamp,
      updated_at: stamp,
      versions: [{ version: 1, sha256: hash, created_at: stamp, message: 'seed' }]
    }
    atomicWriteText(versionFile(ctx, entry.type, entry.id, 1), text)
    atomicWriteText(contentFile(ctx, entry.type, entry.id), text)
    appendChangelog(ctx, meta, 'seed', 1, 'seed')
    ctx.atomicWriteJson(metaFile(ctx, entry.type, entry.id), meta)
    created[entry.type]++
  }
  const total = (counts: Record<AgentType, number>) => counts.skill + counts.agent + counts.profile
  ctx.sendJson(res, 200, {
    created,
    skipped,
    created_total: total(created),
    skipped_total: total(skipped)
  })
}

/** Seed names come from the frontmatter when present, else the id suffix. */
function seedName(entry: SeedEntry, text: string): string {
  if (entry.type !== 'profile') {
    const name = frontmatterOf(text)?.name
    if (name) return name
  } else {
    try {
      const doc = JSON.parse(text)
      if (isRecord(doc) && typeof doc.name === 'string' && doc.name) return doc.name
    } catch {
      // fall through to the id suffix
    }
  }
  return entry.id.replace(/^seed-/, '')
}

function splitRoute(pathname: string): { type: string; id: string; action: string | null } | null {
  const rest = pathname.slice('/api/agents/'.length)
  const parts = rest.split('/')
  if (parts.length === 2) return { type: parts[0], id: parts[1], action: null }
  if (parts.length === 3) return { type: parts[0], id: parts[1], action: parts[2] }
  return null
}

export async function handleAgentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  ctx: AgentsContext
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase()
  const isRead = method === 'GET' || method === 'HEAD'
  try {
    if (pathname === '/api/agents' || pathname === '/api/agents/') {
      if (!isRead) throw new AgentsError(405, 'method_not_allowed', '仅支持 GET')
      listRoute(ctx, url, res)
      return true
    }

    if (pathname === '/api/agents/seed') {
      if (method !== 'POST') throw new AgentsError(405, 'method_not_allowed', '仅支持 POST')
      seedRoute(ctx, req, res)
      return true
    }

    if (pathname === '/api/agents/import') {
      if (method !== 'POST') throw new AgentsError(405, 'method_not_allowed', '仅支持 POST')
      await importRoute(ctx, req, res)
      return true
    }

    if (!pathname.startsWith('/api/agents/')) return false
    const parts = splitRoute(pathname)
    if (!parts) throw new AgentsError(400, 'invalid_path', '无法解析的资源路径')
    if (!isAgentType(parts.type)) throw new AgentsError(400, 'invalid_type', `未知类型 ${parts.type}`)
    const type = parts.type
    const { id, action } = parts
    if (!ID_RE.test(id)) throw new AgentsError(400, 'invalid_id', `id 不合法: ${id}`)

    if (!action) {
      if (isRead) {
        detailRoute(ctx, type, id, res)
        return true
      }
      if (method === 'PUT') {
        await putRoute(ctx, req, res, type, id)
        return true
      }
      throw new AgentsError(405, 'method_not_allowed', '仅支持 GET / PUT')
    }

    if (action === 'skills') {
      if (method !== 'POST') throw new AgentsError(405, 'method_not_allowed', '仅支持 POST')
      if (type !== 'agent') throw new AgentsError(400, 'invalid_type', '仅 agent 支持项目技能绑定')
      await skillsRoute(ctx, req, res, id)
      return true
    }

    if (action === 'export') {
      if (!isRead) throw new AgentsError(405, 'method_not_allowed', '仅支持 GET')
      exportRoute(ctx, res, type, id)
      return true
    }
    if (action === 'diff') {
      if (!isRead) throw new AgentsError(405, 'method_not_allowed', '仅支持 GET')
      diffRoute(ctx, url, res, type, id)
      return true
    }
    if (action === 'rollback') {
      if (method !== 'POST') throw new AgentsError(405, 'method_not_allowed', '仅支持 POST')
      await rollbackRoute(ctx, req, res, type, id)
      return true
    }
    if (action === 'toggle') {
      if (method !== 'POST') throw new AgentsError(405, 'method_not_allowed', '仅支持 POST')
      await toggleRoute(ctx, req, res, type, id)
      return true
    }
    throw new AgentsError(404, 'not_found', `未知操作 ${action}`)
  } catch (err) {
    if (err instanceof AgentsError) {
      ctx.sendJson(res, err.status, { error: err.code, reason: err.reason })
    } else {
      console.error('[agents] unexpected error:', err)
      ctx.sendJson(res, 500, { error: 'internal_error', reason: (err as Error).message })
    }
    return true
  }
}
