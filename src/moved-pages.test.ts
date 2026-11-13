import assert from 'node:assert/strict'
import test from 'node:test'
import { MOVED_PAGES, NEW_ENTRIES, movedPageFor } from './moved-pages'

/* #125 旧深链：5 个已删页面保留说明页，并指向仍可用的入口。 */
test('#125 旧路径全部有迁移说明，不再静默跳首页', () => {
  for (const path of ['/status', '/reports', '/issues', '/flow', '/pipeline']) {
    const moved = movedPageFor(path)
    assert.ok(moved, path)
    assert.equal(moved.path, path)
    assert.ok(moved.oldName.length > 0, path)
    assert.ok(moved.title.endsWith('已迁移'), path)
    assert.ok(moved.reason.length > 0, path)
  }
  assert.equal(Object.keys(MOVED_PAGES).length, 5)
})

/* 每个旧路径的推荐入口必须是真实存在的新入口。 */
test('#125 迁移页的推荐入口都在新入口清单内', () => {
  const targets = new Set(NEW_ENTRIES.map((entry) => entry.to))
  for (const moved of Object.values(MOVED_PAGES)) {
    assert.ok(targets.has(moved.primaryTo), `${moved.path} -> ${moved.primaryTo}`)
  }
  assert.equal(movedPageFor('/status')?.primaryTo, '/')
  assert.equal(movedPageFor('/reports')?.primaryTo, '/')
  assert.equal(movedPageFor('/issues')?.primaryTo, '/')
  assert.equal(movedPageFor('/flow')?.primaryTo, '/studio')
  assert.equal(movedPageFor('/pipeline')?.primaryTo, '/studio')
})

/* 新入口清单覆盖六个现存页面，且没有重复路径。 */
test('#125 新入口清单覆盖 / /studio /jobs /qc /deliveries /agents', () => {
  const targets = NEW_ENTRIES.map((entry) => entry.to)
  assert.deepEqual(targets, ['/', '/studio', '/jobs', '/qc', '/deliveries', '/agents'])
  assert.equal(new Set(targets).size, targets.length)
})

/* 非旧路径不进入迁移页，继续走「页面不存在」。 */
test('#125 未知路径不匹配迁移映射', () => {
  for (const path of ['', '/', '/nope', '/statusx', '/job/web-a']) {
    assert.equal(movedPageFor(path), null, path)
  }
})
