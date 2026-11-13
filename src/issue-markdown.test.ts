/**
 * #110 XSS + reply validation unit tests.
 *
 * The drawer renders Markdown as React elements; these tests pin the parser
 * contract so raw HTML never becomes markup and unsafe link schemes stay text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMENT_MAX,
  parseInline,
  parseMarkdown,
  safeHref,
  validateComment
} from './issue-markdown'

test('raw HTML stays a text token (XSS)', () => {
  // Given a comment body containing a script tag
  const tokens = parseInline('<script>alert(1)</script>')
  // Then it is plain text, never a markup token
  assert.deepEqual(tokens, [{ kind: 'text', text: '<script>alert(1)</script>' }])
})

test('img onerror stays a text token (XSS)', () => {
  const tokens = parseInline('<img src=x onerror=alert(1)>')
  assert.ok(tokens.every((token) => token.kind === 'text'))
  assert.equal(tokens.map((token) => token.text).join(''), '<img src=x onerror=alert(1)>')
})

test('javascript: links are not emitted as links', () => {
  // Given a Markdown link with a script scheme
  const tokens = parseInline('[点我](javascript:alert(1))')
  // Then it stays literal text
  assert.ok(tokens.every((token) => token.kind !== 'link'))
  assert.equal(tokens.map((token) => token.text).join(''), '[点我](javascript:alert(1))')
})

test('safe links keep their href', () => {
  const tokens = parseInline('[Gitea](https://gitea.example/issues/1)')
  assert.deepEqual(tokens, [
    { kind: 'link', text: 'Gitea', href: 'https://gitea.example/issues/1' }
  ])
})

test('safeHref rejects script/data/file schemes and protocol-relative URLs', () => {
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('java\tscript:alert(1)'), null)
  assert.equal(safeHref('data:text/html,<script>x</script>'), null)
  assert.equal(safeHref('file:///etc/passwd'), null)
  assert.equal(safeHref('//evil.example/x'), null)
  assert.equal(safeHref('https://gitea.example/x'), 'https://gitea.example/x')
  assert.equal(safeHref('/issues/1'), '/issues/1')
  assert.equal(safeHref('#comment-2'), '#comment-2')
})

test('Markdown blocks: heading, list, code, quote, paragraph', () => {
  const blocks = parseMarkdown(
    '# 标题\n\n- 一\n- 二\n\n> 引用\n\n```\nconst a = 1\n```\n\n正文第一行\n正文第二行'
  )
  assert.deepEqual(blocks, [
    { kind: 'heading', level: 1, text: '标题' },
    { kind: 'list', ordered: false, items: ['一', '二'] },
    { kind: 'quote', text: '引用' },
    { kind: 'code', text: 'const a = 1' },
    { kind: 'paragraph', text: '正文第一行\n正文第二行' }
  ])
})

test('reply validation: empty, whitespace and overlong are rejected', () => {
  assert.deepEqual(validateComment('   '), { ok: false, error: '回复不能为空' })
  assert.deepEqual(validateComment('x'.repeat(COMMENT_MAX + 1)), {
    ok: false,
    error: `回复不能超过 ${COMMENT_MAX} 字符`
  })
  assert.deepEqual(validateComment('  收到  '), { ok: true, body: '收到' })
})
