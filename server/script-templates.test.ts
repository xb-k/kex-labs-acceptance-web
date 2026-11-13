/**
 * #134: director-template library contract tests.
 *
 * Covers the default JSON extraction (every field frozen below so a future
 * refactor cannot silently drift), override merging + `source`, invalid
 * override handling with warnings, PUT validation, restore-default, legacy
 * store fallback, auth, the HTTP contract, and esbuild-bundled JSON loading.
 *
 * Run with `npm run test:server`.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  GITHUB_SCRIPT_TEMPLATES,
  TEMPLATE_OVERRIDES_RELATIVE_PATH,
  listMergedScriptTemplates,
  removeTemplateOverride,
  saveTemplateOverride,
  validateTemplatePatch
} from './script-templates'
import type { ScriptPromptTemplate } from './script-templates'
import { handleScriptTemplatesRoute } from './script-templates-api'
import { authorizeTaskWrite } from './api'

const ROOT = process.cwd()
const TOKEN = 'templates-134-token'
const tempRoots: string[] = []

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-134-'))
  tempRoots.push(dir)
  return dir
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function writeOverride(root: string, value: unknown, file = TEMPLATE_OVERRIDES_RELATIVE_PATH) {
  atomicWriteJson(path.join(root, file), value)
}

const EXPECTED_DEFAULTS: ScriptPromptTemplate[] = [
  {
    "id": "marketing",
    "category": "营销",
    "label": "营销广告 · 高转化商业片",
    "englishName": "Commercial Hook-Payoff Compiler",
    "githubStandard": "juspay/director · smixs/visual-skills (Commercial Spec)",
    "sourceUrl": "https://raw.githubusercontent.com/smixs/visual-skills/main/README.md",
    "summary": "前 3 秒建立强视觉钩子与材质反差，中段密集呈现产品价值证据，结尾留出清晰品牌落版与情绪记忆点。",
    "structureBeats": "01 强钩子开场 (2.5s) → 02 痛点/渴望情境 → 03 核心材质微距高光 → 04 品牌落版收口",
    "opticalSpec": "35mm / 50mm / 85mm 大光圈切换 · 2.5s~4.0s 紧凑剪辑 · 侧逆光塑形 · 商业青橙反差",
    "recommendedProfile": "ad_teal_orange",
    "recommendedDurationS": 15,
    "recommendedAspect": "16:9",
    "systemDirectives": "[GitHub Spec: juspay/director Commercial Hook-Payoff + smixs/visual-skills]\n- 开场第 1 镜必须在 2.5~3.5s 内给出最具冲击力的物理特写或动势冲突（Visual Hook），拒绝平庸空镜铺垫。\n- 中段镜头按「材质纹理微距 (85mm) → 使用场景中景 (35mm/50mm)」交替推进，突出触感、反光与声效拟音 (Foley)。\n- 旁白采用短句、强动词与留白停顿结合，为品牌 Slogan 或核心卖点留足最终 3 秒视觉停顿空间。\n- I2V prompt 重点强化 specular highlights, tactile surface micro-detail, directional rim lighting 与 crisp motion cadence。"
  },
  {
    "id": "documentary",
    "category": "纪录片",
    "label": "人文纪实 · 观察式纪录片",
    "englishName": "Observational Verité Director",
    "githubStandard": "0xhughs/director-skills (Verité Documentary Protocol)",
    "sourceUrl": "https://raw.githubusercontent.com/0xhughs/director-skills/main/README.md",
    "summary": "遵循观察式电影规范，用自然窗光、真实动作与同期环境音取代过度表演与广告腔，营造可信在场感。",
    "structureBeats": "01 空间环境定场 → 02 人物专注劳作/习惯细节 → 03 同期声/内心独白切入 → 04 克制余韵收尾",
    "opticalSpec": "35mm / 50mm 人文定焦 · 4.0s~6.5s 耐心长镜头 · 自然顶光/窗光 · 轻微肩扛呼吸感",
    "recommendedProfile": "doc_neutral",
    "recommendedDurationS": 30,
    "recommendedAspect": "16:9",
    "systemDirectives": "[GitHub Spec: 0xhughs/director-skills Observational Verité]\n- 严禁商业广告式浮夸推拉、过度柔焦或口号式解说词；全部镜头必须服务于「在场观察与时间流逝」。\n- 优先使用 35mm 与 50mm 人文定焦视角、4.0s~6.5s 舒缓单镜时长，允许主体短暂走出/走进景深平面。\n- 光线遵循现场物理光源（阴天漫反射窗光、室内台灯局部照明、自然环境反射），明确标注真实色温（如 4500K-5600K）。\n- 旁白克制真诚，优先保留真实环境底噪、脚步声、器物碰撞等同期声层次（Diegetic Sound First）。"
  },
  {
    "id": "narrative",
    "category": "叙事",
    "label": "剧情叙事 · 电影感短片",
    "englishName": "Dramatic Continuity Storyboard",
    "githubStandard": "Mirza-Luqman/prompt-storyboard-studio (Continuity Lock)",
    "sourceUrl": "https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md",
    "summary": "严格锁定 180° 轴线、人物视线匹配与情绪光比变化，以戏剧弧光驱动每一组正反打与转折镜头。",
    "structureBeats": "01 情境建置与冲突暗线 → 02 人物关系试探/推进 → 03 情绪高潮瞬间 → 04 留白与戏剧余味",
    "opticalSpec": "24mm 空间调度 + 85mm 情绪特写 · 严格 180° 视线匹配 · 明暗光比过渡",
    "recommendedProfile": "ad_teal_orange",
    "recommendedDurationS": 30,
    "recommendedAspect": "16:9",
    "supportsNovelSeries": true,
    "systemDirectives": "[GitHub Spec: Mirza-Luqman/prompt-storyboard-studio Dramatic Continuity]\n- 必须以完整戏剧弧光组织分场：Setup（建置）→ Escalation（升级）→ Turning Point（转折）→ Aftermath（余波）。\n- continuity_anchor 必须显式锁定 180 度轴线朝向（screen-left / screen-right）、人物服装道具持握状态及视线焦点（eyeline match）。\n- 镜头景别遵循戏剧张力递进：用 24mm/35mm 交待人物与空间孤立感，在情绪转折点切入 85mm 浅景深面部/手部动作特写。\n- 台词或旁白重潜台词（Subtext），用「视觉动作+环境声断奏」传达内心波动，避免直接把情绪说白。"
  },
  {
    "id": "historical_novel",
    "category": "小说历史",
    "label": "小说历史 · 史实长故事连载",
    "englishName": "Historical Novel & Multi-Chapter Compiler",
    "githubStandard": "Mirza-Luqman/prompt-storyboard-studio + Historical Grounding Spec",
    "sourceUrl": "https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md",
    "summary": "专为整部小说/历史传奇打造：先核验朝代史实、服饰礼制与器物建筑，再生成多章节脉络与本集高精度分场剧本。",
    "structureBeats": "01 时代气象与历史定场 → 02 人物命运伏笔 → 03 时代冲突与器物细节 → 04 章节留白悬念",
    "opticalSpec": "24mm 时代建筑群景 + 50mm 叙事中景 + 85mm 器物/神态特写 · 史实服饰色温严格锁定",
    "recommendedProfile": "doc_neutral",
    "recommendedDurationS": 60,
    "recommendedAspect": "16:9",
    "supportsNovelSeries": true,
    "systemDirectives": "[GitHub Spec: Historical Novel & Multi-Chapter Storyboard Compiler]\n- 严禁历史穿越违和（如宋代以前出现明清服饰建筑、尚未传入中国的农作物/器物、错误官职礼仪与纪年）。\n- 必须先依据核验后的史实语境锁定时代细节（服饰形制、发冠佩饰、家具陈设、照明介质如油灯/烛台/自然天光、建筑斗拱形制）。\n- 若为「整部小说 · 多章分集」模式，必须产出连贯的章节总纲（chapters），包含跨章节视觉记忆锚点与人物成长弧光，再细化当前集的高精度分场剧本。\n- I2V 英文提示词必须显式写出准确的时代材质（e.g. Tang Dynasty round-collar silk robe, unglazed stoneware lamp, timber bracket architecture）与自然胶片质感。"
  },
  {
    "id": "vlog",
    "category": "Vlog",
    "label": "生活方式 · 轻纪实 Vlog",
    "englishName": "First-Person Kinetic Storyteller",
    "githubStandard": "0xhughs/director-skills (Kinetic Handheld Spec)",
    "sourceUrl": "https://raw.githubusercontent.com/0xhughs/director-skills/main/README.md",
    "summary": "第一人称沉浸视角、轻快动作剪辑与高质感 ASMR 拟音，兼具随性真实感与高留存率节奏。",
    "structureBeats": "01 推门/出发第一视角 → 02 空间风物与细节采样 → 03 沉浸式交互过程 → 04 轻盈收束金句",
    "opticalSpec": "24mm / 35mm 亲近视角 · 2.5s~4.5s 动作匹配剪辑 · 适度手持呼吸感 · 温暖胶片肤色",
    "recommendedProfile": "vlog_warm_film",
    "recommendedDurationS": 20,
    "recommendedAspect": "9:16",
    "systemDirectives": "[GitHub Spec: director-skills Kinetic First-Person Vlog]\n- 采用第一人称或贴身跟拍视角（24mm/35mm），强调动作匹配转场（Match Cut，如推门、放杯、抬头瞬间衔接）。\n- 节奏轻快明朗，单镜控制在 2.5s~4.5s，每场明确写入 1 个标志性生活拟音细节（风铃、冰块撞杯、纸张翻页）。\n- 旁白口吻像与好友面对面聊天，自然松弛有呼吸停顿，绝不使用播音腔或书面八股。\n- I2V prompt 显式包含 subtle handheld natural sway, warm filmic skin tones, golden-hour window spill。"
  },
  {
    "id": "product_demo",
    "category": "评测",
    "label": "产品演示 · 极简工业微距",
    "englishName": "Industrial Macro & Motion Control",
    "githubStandard": "smixs/visual-skills (Studio Tabletop Motion)",
    "sourceUrl": "https://raw.githubusercontent.com/smixs/visual-skills/main/README.md",
    "summary": "专为数码硬件、工艺器物与功能产品设计，强调电控滑轨精确位移、倒角扫光与一镜看懂核心结构。",
    "structureBeats": "01 暗调轮廓扫光唤醒 → 02 核心结构交互动作 → 03 功能/界面工作状态 → 04 全貌参数收口",
    "opticalSpec": "85mm / 100mm 微距滑轨 · 零手持抖动精密运动 · 受控柔光箱边缘高光 · 中性高锐还原",
    "recommendedProfile": "doc_neutral",
    "recommendedDurationS": 20,
    "recommendedAspect": "16:9",
    "systemDirectives": "[GitHub Spec: smixs/visual-skills Industrial Tabletop Spec]\n- 严禁手持晃动；全部运镜必须为精确的电控滑轨、机械臂弧线围绕或锁定微距推轨（slider / orbital arc）。\n- 着重描写表面工艺物理反馈（阳极氧化铝、拉丝金属、玻璃镀膜、磨砂阻尼、指示灯点亮渐变）。\n- 布光采用可追溯的棚拍光源（overhead diffused softbox、narrow strip rim light carving metallic bevels）。\n- 口播精准客观，用可视化动作替代抽象形容词，让观众不靠字幕也能看懂产品工作原理。"
  },
  {
    "id": "scenic_essay",
    "category": "散文",
    "label": "视觉散文 · 城市/自然史诗",
    "englishName": "Atmospheric Spatial Essay",
    "githubStandard": "prompt-storyboard-studio (Wide Architectural Poem)",
    "sourceUrl": "https://raw.githubusercontent.com/Mirza-Luqman/prompt-storyboard-studio/main/README.md",
    "summary": "以空间尺度、气象光线与城市/自然韵律为核心，构建极具电影院线大银幕呼吸感的低饱和视觉诗。",
    "structureBeats": "01 广角气象与建筑定场 → 02 光影水流动态细节 → 03 人与空间尺度剪影 → 04 天光渐变定格",
    "opticalSpec": "16mm / 24mm 建筑广角 · 4.5s~6.5s 极缓推轨/航拍感 · 蓝调时刻/雨夜反射 · 低饱和电影感",
    "recommendedProfile": "landscape_low_sat",
    "recommendedDurationS": 20,
    "recommendedAspect": "16:9",
    "systemDirectives": "[GitHub Spec: prompt-storyboard-studio Atmospheric Spatial Essay]\n- 强调大空间透视线条（24mm architectural symmetry, leading lines, vast negative space）与缓慢克制的摄影机移动。\n- 核心描述围绕空气介质与光线演变展开（wet asphalt neon reflections, morning mist scattering, blue-hour twilight gradient）。\n- 旁白如电影画外音散文诗般精炼节制，允许 1~2 场完全由自然环境声与音乐留白承载。\n- 禁止急促闪切，每镜维持 4.0s~6.5s 的沉静视觉呼吸时长。"
  }
]

test('内置 JSON 与原 7 条定义逐字段一致（防抽离漂移）', () => {
  // Given the canonical default file bundled into the server
  // When the loader exposes the library
  // Then all seven templates match the frozen pre-extraction values
  assert.deepEqual(GITHUB_SCRIPT_TEMPLATES, EXPECTED_DEFAULTS)
  assert.deepEqual(
    GITHUB_SCRIPT_TEMPLATES.map((t) => t.id),
    ['marketing', 'documentary', 'narrative', 'historical_novel', 'vlog', 'product_demo', 'scenic_essay']
  )
})

test('overrides.json 按 id 合并字段，并用 source 标出覆盖来源', () => {
  const root = tempRoot()
  writeOverride(root, {
    marketing: { label: '自定义营销标签', summary: '自定义摘要', recommendedDurationS: 30, recommendedAspect: '9:16' },
    documentary: { recommendedProfile: 'landscape_low_sat' }
  })

  const { items, warnings } = listMergedScriptTemplates(root, readJson)
  const marketing = items.find((t) => t.id === 'marketing')!
  const documentary = items.find((t) => t.id === 'documentary')!
  const narrative = items.find((t) => t.id === 'narrative')!

  assert.equal(warnings.length, 0)
  assert.equal(marketing.label, '自定义营销标签')
  assert.equal(marketing.summary, '自定义摘要')
  assert.equal(marketing.recommendedDurationS, 30)
  assert.equal(marketing.recommendedAspect, '9:16')
  assert.equal(marketing.systemDirectives, EXPECTED_DEFAULTS[0].systemDirectives)
  assert.equal(marketing.source, 'override')
  assert.equal(documentary.recommendedProfile, 'landscape_low_sat')
  assert.equal(documentary.source, 'override')
  assert.equal(narrative.source, 'default')
})

test('非法 id/字段/类型/枚举/长度被忽略并记入 warnings', () => {
  const root = tempRoot()
  writeOverride(root, {
    unknown_id: { label: '不应出现' },
    marketing: { recommendedProfile: 'neon_dream' },
    documentary: { label: 'x'.repeat(81) },
    narrative: { recommendedDurationS: '30' },
    vlog: { label: '合法标签', englishName: 'Unsupported Field' },
    historical_novel: []
  })

  const { items, warnings } = listMergedScriptTemplates(root, readJson)
  assert.deepEqual(
    items,
    EXPECTED_DEFAULTS.map((t) => ({
      ...t,
      ...(t.id === 'vlog' ? { label: '合法标签' } : {}),
      source: t.id === 'vlog' ? 'override' : 'default'
    }))
  )
  assert.ok(warnings.some((w) => w.startsWith('unknown_id:')))
  assert.ok(warnings.some((w) => w.startsWith('marketing.recommendedProfile:')))
  assert.ok(warnings.some((w) => w.startsWith('documentary.label:')))
  assert.ok(warnings.some((w) => w.startsWith('narrative.recommendedDurationS:')))
  assert.ok(warnings.some((w) => w.startsWith('vlog.englishName:')))
  assert.ok(warnings.some((w) => w.startsWith('historical_novel:')))
})

test('旧 script-templates-overrides.json 在 canonical 缺失时仍生效', () => {
  const root = tempRoot()
  writeOverride(root, { marketing: { label: '旧存储标签' } }, 'script-templates-overrides.json')

  const { items, warnings } = listMergedScriptTemplates(root, readJson)
  assert.equal(items.find((t) => t.id === 'marketing')!.label, '旧存储标签')
  assert.ok(warnings.some((w) => w.startsWith('legacy script-templates-overrides.json')))
})

test('saveTemplateOverride 原子写入 canonical，removeTemplateOverride 恢复默认', () => {
  const root = tempRoot()
  const saved = saveTemplateOverride({
    dataRoot: root,
    id: 'narrative',
    patch: { label: '新叙事标签', recommendedDurationS: 45 },
    readJson,
    atomicWriteJson
  })
  assert.equal(saved.label, '新叙事标签')
  assert.equal(saved.source, 'override')
  assert.deepEqual(readJson(path.join(root, TEMPLATE_OVERRIDES_RELATIVE_PATH)), {
    narrative: { label: '新叙事标签', recommendedDurationS: 45 }
  })

  const removed = removeTemplateOverride({ dataRoot: root, id: 'narrative', readJson, atomicWriteJson })
  assert.equal(removed.removed, true)
  assert.equal(removed.item.label, EXPECTED_DEFAULTS[2].label)
  assert.equal(removed.item.source, 'default')
  assert.deepEqual(readJson(path.join(root, TEMPLATE_OVERRIDES_RELATIVE_PATH)), {})

  const second = removeTemplateOverride({ dataRoot: root, id: 'narrative', readJson, atomicWriteJson })
  assert.equal(second.removed, false)
})

test('validateTemplatePatch 拒绝非法字段/枚举/长度，接受允许字段', () => {
  assert.deepEqual(validateTemplatePatch({ label: '  新标签  ', recommendedAspect: '1:1' }), {
    ok: true,
    patch: { label: '新标签', recommendedAspect: '1:1' }
  })
  const unsupported = validateTemplatePatch({ category: '营销' })
  assert.equal(unsupported.ok, false)
  if (!unsupported.ok) assert.match(unsupported.error, /unsupported field: category/)
  const enumError = validateTemplatePatch({ recommendedDurationS: 33 })
  assert.equal(enumError.ok, false)
  if (!enumError.ok) assert.match(enumError.error, /recommendedDurationS/)
  const tooLong = validateTemplatePatch({ systemDirectives: 'x'.repeat(4001) })
  assert.equal(tooLong.ok, false)
  const empty = validateTemplatePatch({})
  assert.equal(empty.ok, false)
})

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) {
        reject(new Error('empty body'))
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function startServer(
  dataRoot: string,
  env: NodeJS.ProcessEnv
): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
        const handled = await handleScriptTemplatesRoute(req, res, pathname, {
          dataRoot,
          readJson,
          atomicWriteJson,
          readBody,
          authorize: (request) => authorizeTaskWrite(request, env),
          sendJson
        })
        if (!handled) {
          res.statusCode = 404
          res.end()
        }
      } catch (err) {
        res.statusCode = 500
        res.end(String(err))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

test('GET 公开；PUT/DELETE 受 authorizeTaskWrite 保护；覆盖与恢复走完整 HTTP 链路', async () => {
  const root = tempRoot()
  const { server, base } = await startServer(root, { WEB_WRITE_TOKEN: TOKEN })
  try {
    const list = await fetch(`${base}/api/script-templates`)
    assert.equal(list.status, 200)
    const page = (await list.json()) as { items: Array<{ id: string; label: string; source: string }>; total: number }
    assert.equal(page.total, 7)
    assert.ok(page.items.every((t) => t.source === 'default'))

    const anonymous = await fetch(`${base}/api/script-templates/marketing`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'x' })
    })
    assert.equal(anonymous.status, 403)

    const wrongToken = await fetch(`${base}/api/script-templates/marketing`, {
      method: 'PUT',
      headers: { 'x-web-token': 'nope' },
      body: JSON.stringify({ label: 'x' })
    })
    assert.equal(wrongToken.status, 401)

    const anonymousRestore = await fetch(`${base}/api/script-templates/marketing/override`, {
      method: 'DELETE'
    })
    assert.equal(anonymousRestore.status, 403)

    const updated = await fetch(`${base}/api/script-templates/marketing`, {
      method: 'PUT',
      headers: { 'x-web-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'HTTP 新标签', recommendedProfile: 'doc_neutral' })
    })
    assert.equal(updated.status, 200)
    const updatedBody = (await updated.json()) as { item: { label: string; source: string } }
    assert.equal(updatedBody.item.label, 'HTTP 新标签')
    assert.equal(updatedBody.item.source, 'override')

    const afterPut = (await (await fetch(`${base}/api/script-templates`)).json()) as {
      items: Array<{ id: string; label: string; source: string }>
      warnings: string[]
    }
    assert.equal(afterPut.items.find((t) => t.id === 'marketing')!.source, 'override')
    assert.equal(afterPut.items.find((t) => t.id === 'marketing')!.label, 'HTTP 新标签')
    assert.deepEqual(afterPut.warnings, [])

    const rejectedField = await fetch(`${base}/api/script-templates/marketing`, {
      method: 'PUT',
      headers: { 'x-web-token': TOKEN },
      body: JSON.stringify({ category: '营销' })
    })
    assert.equal(rejectedField.status, 400)

    const rejectedEnum = await fetch(`${base}/api/script-templates/marketing`, {
      method: 'PUT',
      headers: { 'x-web-token': TOKEN },
      body: JSON.stringify({ recommendedAspect: '21:9' })
    })
    assert.equal(rejectedEnum.status, 400)

    const unknown = await fetch(`${base}/api/script-templates/nope`, {
      method: 'PUT',
      headers: { 'x-web-token': TOKEN },
      body: JSON.stringify({ label: 'x' })
    })
    assert.equal(unknown.status, 404)

    const unknownRestore = await fetch(`${base}/api/script-templates/nope/override`, {
      method: 'DELETE',
      headers: { 'x-web-token': TOKEN }
    })
    assert.equal(unknownRestore.status, 404)

    const restored = await fetch(`${base}/api/script-templates/marketing/override`, {
      method: 'DELETE',
      headers: { 'x-web-token': TOKEN }
    })
    assert.equal(restored.status, 200)
    const restoredBody = (await restored.json()) as { item: { label: string; source: string }; removed: boolean }
    assert.equal(restoredBody.removed, true)
    assert.equal(restoredBody.item.label, EXPECTED_DEFAULTS[0].label)
    assert.equal(restoredBody.item.source, 'default')

    const afterRestore = (await (await fetch(`${base}/api/script-templates`)).json()) as {
      items: Array<{ id: string; label: string; source: string }>
    }
    assert.equal(afterRestore.items.find((t) => t.id === 'marketing')!.source, 'default')
  } finally {
    server.close()
  }
})

test('默认 JSON 经 esbuild 打包后 node 仍可加载（server 运行时无独立 JSON 文件）', () => {
  const dir = tempRoot()
  const entry = path.join(dir, 'entry.ts')
  const bundle = path.join(dir, 'bundle.mjs')
  fs.writeFileSync(
    entry,
    `import { GITHUB_SCRIPT_TEMPLATES } from ${JSON.stringify(path.join(ROOT, 'server', 'script-templates.ts'))}\n` +
      `console.log(JSON.stringify(GITHUB_SCRIPT_TEMPLATES.map((t) => t.id)))\n`,
    'utf8'
  )
  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild')
  execFileSync(esbuild, [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=warning'], {
    stdio: 'pipe'
  })
  const stdout = execFileSync(process.execPath, [bundle], { encoding: 'utf8' })
  assert.equal(
    stdout.trim(),
    JSON.stringify(['marketing', 'documentary', 'narrative', 'historical_novel', 'vlog', 'product_demo', 'scenic_essay'])
  )
  assert.equal(fs.existsSync(path.join(dir, 'script-templates.default.json')), false)
})
