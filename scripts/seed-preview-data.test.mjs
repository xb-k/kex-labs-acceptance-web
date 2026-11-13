import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { checkPreviewOutput, PREVIEW_DIRNAME } from './preview-data-guard.mjs'

const HERE = import.meta.dirname
const SCRIPT = path.join(HERE, 'seed-preview-data.mjs')

test('preview-data guard: 只允许写入 .preview-data/', () => {
  const cwd = '/tmp/seed-guard-case'

  assert.equal(checkPreviewOutput({ target: path.join(cwd, '.preview-data'), cwd }).ok, true)
  assert.equal(checkPreviewOutput({ target: path.join(cwd, '.preview-data', 'data', 'jobs'), cwd }).ok, true)

  const outside = checkPreviewOutput({ target: path.join(cwd, 'data'), cwd })
  assert.equal(outside.ok, false)
  assert.match(outside.reason, /只允许写入 \.preview-data/)

  const sibling = checkPreviewOutput({ target: path.join(cwd, '..', '.preview-data-evil'), cwd })
  assert.equal(sibling.ok, false)
})

test('preview-data guard: 拒绝等于/位于 WEB_DATA_ROOT 的目标', () => {
  const cwd = '/tmp/seed-guard-case'
  const preview = path.join(cwd, PREVIEW_DIRNAME)
  const target = path.join(preview, 'data')

  const equal = checkPreviewOutput({ target, cwd, webDataRoot: preview })
  assert.equal(equal.ok, false)
  assert.match(equal.reason, /WEB_DATA_ROOT/)

  const parent = checkPreviewOutput({ target, cwd, webDataRoot: cwd })
  assert.equal(parent.ok, false)
  assert.match(parent.reason, /WEB_DATA_ROOT/)

  const unrelated = checkPreviewOutput({ target, cwd, webDataRoot: '/var/lib/acceptance-data' })
  assert.equal(unrelated.ok, true)
})

test('preview-data guard: 输出根必须是 .preview-data', () => {
  const result = checkPreviewOutput({
    target: '/tmp/seed-guard-case/not-preview/data',
    cwd: '/tmp/seed-guard-case',
    previewRoot: '/tmp/seed-guard-case/not-preview'
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /不是 \.preview-data/)
})

test('seed-preview-data: WEB_DATA_ROOT 冲突时 exit 2 且不创建任何文件', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-preview-guard-'))
  const preview = path.join(cwd, PREVIEW_DIRNAME)
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: { ...process.env, WEB_DATA_ROOT: preview },
    encoding: 'utf8'
  })

  assert.equal(run.status, 2, run.stderr)
  assert.match(run.stderr, /拒绝写入/)
  assert.match(run.stderr, /WEB_DATA_ROOT/)
  assert.equal(fs.existsSync(preview), false)

  fs.rmSync(cwd, { recursive: true, force: true })
})
