import assert from 'node:assert/strict'
import test from 'node:test'
import { agentNodeExplain, chainLinks, continuityFields, nodeExplain, promptChain, stageExplain } from './flow-explain'

/* AC2：已知 stage 四行白话非空，来源可追。 */
test('#103 stageExplain 已知 A/B2/C/F 返回四行白话与来源', () => {
  for (const key of ['A', 'B', 'B2', 'C', 'D', 'E', 'F']) {
    const item = stageExplain(key)
    assert.equal(item.known, true, key)
    for (const field of [item.role, item.doing, item.output, item.failure, item.source]) {
      assert.ok(field.trim().length > 0, `${key} 字段为空`)
      assert.notEqual(field, '未收录说明')
    }
    assert.ok(item.input.length > 0)
  }
})

/* AC2：未知 / 空 key 明确「未收录说明」，保留原 key。 */
test('#103 stageExplain 未知 key → 未收录说明 + 原始 key', () => {
  for (const key of ['runner', 'assemble', '']) {
    const item = stageExplain(key)
    assert.equal(item.known, false)
    assert.equal(item.key, key)
    assert.equal(item.role, '未收录说明')
    assert.equal(item.doing, '未收录说明')
    assert.equal(item.output, '未收录说明')
    assert.equal(item.failure, '未收录说明')
    assert.ok(item.label.length > 0)
  }
})

/* AC1：6 环节总览固定顺序与字段非空；job 状态只由 stages 派生。 */
test('#103 chainLinks 固定 6 环节，未传 job 时显示未触发', () => {
  const links = chainLinks()
  assert.deepEqual(
    links.map((link) => link.title),
    ['导演 Brief', '分镜 / 场景', '关键帧', '视频片段', '插帧 / 增强', '组装交付']
  )
  for (const link of links) {
    for (const field of [link.role, link.doing, link.input, link.output, link.check, link.source, link.current]) {
      assert.ok(field.trim().length > 0)
    }
  }
  assert.match(links[1].current, /未触发/)
})

test('#103 chainLinks 按 stages 状态派生进度，不改写状态', () => {
  const links = chainLinks([
    { key: 'A', status: 'done' },
    { key: 'B', status: 'done' },
    { key: 'B2', status: 'done' },
    { key: 'C', status: 'failed' }
  ])
  assert.match(links[1].current, /完成（A done · B done · B2 done）/)
  assert.match(links[2].current, /有失败（C failed）/)
  assert.match(links[3].current, /未触发/)
})

/* AC3：已知节点三列非空；未知 class_type 保留原值。 */
test('#103 nodeExplain 已知 KSampler/LTXVImgToVideo 返回职责/参数/失败表现', () => {
  for (const classType of ['KSampler', 'LTXVImgToVideo', 'CheckpointLoaderSimple']) {
    const item = nodeExplain(classType)
    assert.equal(item.known, true)
    assert.equal(item.classType, classType)
    for (const field of [item.duty, item.params, item.failure, item.source]) {
      assert.ok(field.trim().length > 0)
      assert.notEqual(field, '未收录说明')
    }
  }
})

test('#103 nodeExplain 未知 class_type → 未收录说明 + 原值', () => {
  const item = nodeExplain('FooBarNode')
  assert.equal(item.known, false)
  assert.equal(item.classType, 'FooBarNode')
  assert.equal(item.duty, '未收录说明')
  assert.match(item.params, /未收录说明/)
  assert.equal(item.failure, '未收录说明')
})

test('#103 agentNodeExplain 未知节点不返回空文案', () => {
  const item = agentNodeExplain('unknown-kind')
  assert.equal(item.duty, '未收录说明')
  assert.ok(item.params.includes('未收录说明'))
  assert.equal(item.failure, '未收录说明')
})

/* AC4：7 项固定；有值显示值，无值明确未记录，不推测。 */
test('#103 continuityFields 固定 7 项，记录值来自 shot_semantics', () => {
  const rows = continuityFields({
    semantics: null,
    shot_semantics: [
      {
        semantics: {
          subject: { count: 1, kind: 'person', name: 'hero' },
          lighting: { quality: 'soft', direction: 'left', temp_k: 5600, time: 'day' },
          motion: { camera: 'static' }
        }
      }
    ],
    profile: { look: 'doc_neutral' }
  })
  assert.deepEqual(rows.map((row) => row.label), ['角色', '服装', '道具', '光线', '色温', '机位', '背景'])
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0].values, ['person × 1'])
  assert.deepEqual(rows[3].values, ['soft', 'left', 'day'])
  assert.deepEqual(rows[4].values, ['5600K'])
  assert.deepEqual(rows[5].values, ['static'])
  assert.equal(rows[1].recorded, false)
  assert.equal(rows[2].recorded, false)
  assert.equal(rows[6].recorded, false)
  assert.ok(rows[6].note?.includes('doc_neutral'))
})

test('#103 continuityFields 空输入 → 7 项全部未记录，不抛错', () => {
  const rows = continuityFields({ semantics: null, shot_semantics: null, profile: null })
  assert.equal(rows.length, 7)
  assert.ok(rows.every((row) => row.recorded === false))
  assert.ok(rows.every((row) => row.values.length === 0))
  assert.ok(rows.every((row) => Boolean(row.note)))
})

/* AC5：4 段固定；缺失显示未知，不补示例。 */
test('#103 promptChain 固定 4 段，已记录/未记录都带来源', () => {
  const segments = promptChain({
    profile: { prompt: { path: 'prompts/doc_neutral.v1.txt', version: 'v1' } },
    profile_prompt: { path: 'prompts/doc_neutral.v1.txt', version: 'v1', text: 'scene text' },
    stages: [
      {
        key: 'C',
        prompts: [{ text: 'keyframe prompt', negative: 'bad things', shot_id: 1, source: 'state.rendered[].prompt' }]
      },
      {
        key: 'D',
        prompts: [{ text: 'clip prompt', negative: 'bad things', shot_id: 1, source: 'state.clips[].prompt' }]
      }
    ]
  })
  assert.deepEqual(segments.map((item) => item.label), ['导演 brief', '场景 prompt', '镜头 prompt', 'negative prompt'])
  assert.equal(segments[0].text, null)
  assert.match(segments[0].note ?? '', /未记录/)
  assert.equal(segments[1].text, 'scene text')
  assert.match(segments[1].source, /doc_neutral\.v1\.txt/)
  assert.match(segments[2].text ?? '', /keyframe prompt/)
  assert.match(segments[2].text ?? '', /clip prompt/)
  assert.equal(segments[3].text, 'bad things')
  assert.ok(segments.every((item) => item.source.trim().length > 0))
})

test('#103 promptChain 空数据 → 四段均不返回空文案', () => {
  const segments = promptChain({ profile: null, stages: [] })
  assert.equal(segments.length, 4)
  assert.equal(segments[1].text, null)
  assert.match(segments[1].note ?? '', /未记录/)
  assert.match(segments[2].note ?? '', /未记录/)
  assert.match(segments[3].note ?? '', /未记录/)
  assert.ok(segments.every((item) => item.note || item.text))
})
