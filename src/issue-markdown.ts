/**
 * Minimal, XSS-safe Markdown subset for issue bodies and comments (#110).
 *
 * No dependency is added: the parser returns plain data and the renderer emits
 * React elements, so raw HTML in Gitea content is always shown as text — never
 * interpreted. Links are only emitted for http(s)/mailto or relative targets;
 * `javascript:`, `data:` and friends stay literal text.
 */

export const COMMENT_MAX = 8000

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }

/** Accept only schemes a comment can safely link to; relative paths are kept. */
export function safeHref(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  // Browsers ignore control characters inside a scheme (`java\tscript:`).
  const compact = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  if (
    compact.startsWith('javascript:') ||
    compact.startsWith('data:') ||
    compact.startsWith('vbscript:') ||
    compact.startsWith('file:')
  ) {
    return null
  }
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/)
  if (scheme) return scheme[1] === 'http' || scheme[1] === 'https' || scheme[1] === 'mailto' ? value : null
  if (value.startsWith('//')) return null
  return value
}

/** Split one line into text / code / emphasis / link tokens. */
export function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let text = ''
  const flush = () => {
    if (text) {
      tokens.push({ kind: 'text', text })
      text = ''
    }
  }
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)
    const code = rest.match(/^`([^`]+)`/)
    if (code) {
      flush()
      tokens.push({ kind: 'code', text: code[1] })
      i += code[0].length
      continue
    }
    const link = rest.match(/^\[([^\]]*)\]\(([^)\s]+)\)/)
    if (link) {
      const href = safeHref(link[2])
      if (href) {
        flush()
        tokens.push({ kind: 'link', text: link[1], href })
        i += link[0].length
        continue
      }
    }
    const strong = rest.match(/^\*\*([^*]+)\*\*/)
    if (strong) {
      flush()
      tokens.push({ kind: 'strong', text: strong[1] })
      i += strong[0].length
      continue
    }
    const em = rest.match(/^\*([^*]+)\*/)
    if (em) {
      flush()
      tokens.push({ kind: 'em', text: em[1] })
      i += em[0].length
      continue
    }
    text += line[i]
    i += 1
  }
  flush()
  return tokens
}

/** Parse the Markdown subset used by Gitea bodies/comments, block by block. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const fence = line.match(/^```/)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim()
      })
      i += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      continue
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
    if (list) {
      const ordered = /^\d/.test(list[1])
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (!item || /^\d/.test(item[1]) !== ordered) break
        items.push(item[2])
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i]
      if (
        !current.trim() ||
        /^```/.test(current) ||
        /^#{1,3}\s+/.test(current) ||
        /^>\s?/.test(current) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(current)
      ) {
        break
      }
      paragraph.push(current)
      i += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

/** Reply validation shared by the drawer and its unit test. */
export function validateComment(value: string): { ok: true; body: string } | { ok: false; error: string } {
  const body = value.trim()
  if (!body) return { ok: false, error: '回复不能为空' }
  if (body.length > COMMENT_MAX) return { ok: false, error: `回复不能超过 ${COMMENT_MAX} 字符` }
  return { ok: true, body }
}
