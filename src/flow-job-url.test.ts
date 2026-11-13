import assert from 'node:assert/strict'
import test from 'node:test'
import { flowRequestUrl, jobSearch, parseJobParam, resolveFlowJobId } from './flow-job-url'

/* 深链：?job=<id> 首屏生效；空白值不产生伪 job 请求。 */
test('#103 parseJobParam 读 ?job= 深链，空白视为未指定', () => {
  assert.equal(parseJobParam('?job=web-20261113085345-3ebc4c'), 'web-20261113085345-3ebc4c')
  assert.equal(parseJobParam('?x=1&job=web-a'), 'web-a')
  assert.equal(parseJobParam('?job=%20web-a%20'), 'web-a')
  for (const search of ['', '?job=', '?job=%20%20', '?tab=b']) {
    assert.equal(parseJobParam(search), null, search)
  }
})

/* 深链写回：切换 job 保留其它参数；回到默认则删掉 job 参数。 */
test('#103 jobSearch 写回/清除 ?job=，不动其它查询参数', () => {
  assert.equal(jobSearch('', 'web-a'), '?job=web-a')
  assert.equal(jobSearch('?x=1', 'web-a'), '?x=1&job=web-a')
  assert.equal(jobSearch('?job=old&x=1', 'web-new'), '?job=web-new&x=1')
  assert.equal(jobSearch('?job=old&x=1', null), '?x=1')
  assert.equal(jobSearch('?job=old', '  '), '')
})

/* 默认 job：未显式选择时请求默认 feed，而不是 /api/flow?job=null。 */
test('#103 flowRequestUrl 无选择走默认 feed，有选择才带 job', () => {
  assert.equal(flowRequestUrl(null), '/api/flow')
  assert.equal(flowRequestUrl('web-a'), '/api/flow?job=web-a')
  assert.equal(flowRequestUrl('a b'), '/api/flow?job=a%20b')
})

/* 默认 job 渲染：没有 selected 也要解析出 feed 里的 job 并渲染解释层。 */
test('#103 resolveFlowJobId 无选择用默认 job，选择优先于 feed', () => {
  const feed = { job: { id: 'web-latest' }, jobs: [{ id: 'web-latest' }, { id: 'web-old' }] }
  assert.equal(resolveFlowJobId(null, feed), 'web-latest')
  assert.equal(resolveFlowJobId(null, { job: null, jobs: [] }), null)
  assert.equal(resolveFlowJobId(null, { jobs: [{ id: 'web-first' }] }), 'web-first')
  assert.equal(resolveFlowJobId('web-picked', feed), 'web-picked')
  // 深链首屏数据未到时，仍以 URL 选择为准（不闪回默认 job）
  assert.equal(resolveFlowJobId('web-deeplink', null), 'web-deeplink')
})
