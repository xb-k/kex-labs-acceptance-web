import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { checkPreviewOutput, PREVIEW_DIRNAME } from './preview-data-guard.mjs'

// 仅供手动执行：`node scripts/seed-preview-data.mjs`。不接入 npm build / dev / test，
// 也不会被任何构建文件引用；所有写入必须落在 `.preview-data/`。
const ROOT = process.cwd()
const PREVIEW = path.join(ROOT, PREVIEW_DIRNAME)
const DATA = path.join(PREVIEW, 'data')
const KEX = path.join(PREVIEW, 'kex-repo')
const LOGS = path.join(PREVIEW, 'logs')

function assertPreviewTarget(target) {
  const check = checkPreviewOutput({
    target,
    cwd: ROOT,
    webDataRoot: process.env.WEB_DATA_ROOT
  })
  if (!check.ok) {
    console.error(`[seed-preview-data] 拒绝写入：${check.reason}`)
    process.exit(2)
  }
}

function ensureDir(dir) {
  assertPreviewTarget(dir)
  fs.mkdirSync(dir, { recursive: true })
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function writeText(file, text) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, text, 'utf8')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function makeVideo(outPath, { duration = 4, fps = 30, width = 720, height = 1280, eq = '', hue = 0 } = {}) {
  ensureDir(path.dirname(outPath))
  if (fs.existsSync(outPath)) return
  const vf = [
    `format=yuv420p`,
    hue ? `hue=h=${hue}` : '',
    `drawbox=x=24:y=24:w=${width - 48}:h=${height - 48}:color=white@0.22:t=2`,
    eq
  ]
    .filter(Boolean)
    .join(',')
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-loglevel',
      'error',
      outPath
    ],
    { stdio: 'inherit' }
  )
}

function makePng(outPath, { color = '#0f172a', accent = '#38bdf8', boxY = 220 } = {}) {
  ensureDir(path.dirname(outPath))
  if (fs.existsSync(outPath)) return
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=768x512:d=0.1`,
      '-vf',
      `drawbox=x=160:y=${boxY}:w=448:h=160:color=${accent}@0.55:t=fill,drawbox=x=180:y=${boxY + 20}:w=180:h=120:color=white@0.25:t=fill`,
      '-frames:v',
      '1',
      '-loglevel',
      'error',
      outPath
    ],
    { stdio: 'inherit' }
  )
}

function buildCsv(frames, baseLapvar, outMult, noiseBase) {
  const cols = [
    'frame',
    't_s',
    'orig_lapvar',
    'out_lapvar',
    'ssim',
    'noise_change_pct',
    'ghost_ratio',
    'tear_frac',
    'overshoot_frac',
    'skin_dE'
  ]
  const lines = [cols.join(',')]
  for (let i = 0; i < frames; i++) {
    const wave = Math.sin(i * 0.35) * 45 + Math.cos(i * 0.18) * 25
    const orig = Math.max(120, baseLapvar + wave)
    const out = Math.max(200, orig * outMult + (i % 3 === 0 ? 35 : -12))
    const ssim = (0.88 + Math.sin(i * 0.25) * 0.04).toFixed(4)
    const noise = (noiseBase + Math.sin(i * 0.4) * 2.1).toFixed(2)
    const ghost = (0.94 + Math.cos(i * 0.3) * 0.14).toFixed(3)
    const tear = (0.018 + Math.abs(Math.sin(i * 0.2)) * 0.012).toFixed(4)
    const over = (0.068 + Math.abs(Math.cos(i * 0.25)) * 0.025).toFixed(4)
    const de = (2.15 + Math.abs(Math.sin(i * 0.15)) * 0.65).toFixed(2)
    lines.push(
      [
        i,
        (i / 30).toFixed(3),
        orig.toFixed(1),
        out.toFixed(1),
        ssim,
        noise,
        ghost,
        tear,
        over,
        de
      ].join(',')
    )
  }
  return lines.join('\n') + '\n'
}

console.log('Seeding isolated Option C preview data into .preview-data ...')

// 1. Original raw clip
const origMov = path.join(DATA, 'IMG_3189.MOV')
makeVideo(origMov, { color: '#1b1d24', accent: '#64748b', duration: 6, fps: 24, width: 720, height: 1280 })

// 2. Acceptance B-Track jobs (s0 CONDITIONAL, s1 FAIL on noise, s2 PASS)
const s0Dir = path.join(DATA, 'issue-19', 'b-track-s0')
const s0Out = path.join(s0Dir, 'out')
makeVideo(path.join(s0Out, 's0_preview.mp4'), { color: '#172030', accent: '#38bdf8', duration: 4, fps: 30, width: 720, height: 1280 })
writeJson(path.join(s0Dir, 'summary_v2.json'), {
  task_id: 'T-B-019-S0',
  verdict: 'PASS (CONDITIONAL: 噪声口径未冻结)',
  B1_ssim_mean: 0.892,
  B1_ssim_min: 0.831,
  B2_net_gain_vs_baseline_ratio: 1.88,
  B2_noise_change_pct: 19.4,
  B3_ghost_ratio_median: 1.08,
  B3_ghost_ratio_min: 0.89,
  B3_ghost_ratio_max: 1.32,
  B3_tear_frac_mean: 0.021,
  B3_tear_frac_max: 0.048,
  B3_overshoot_frac_mean: 0.3289,
  B3_overshoot_frac_p95: 0.349,
  B3_skin_dE_mean: 12.89,
  B3_skin_dE_attribution: { orig_to_pre_grade: 0.37, grade_color_awb: 12.52 },
  clip: { duration_s: 4.0, fps: 30, width: 720, height: 1280, crf: 18 },
  chain: 'LTX-2B -> RIFE 2x -> Real-ESRGAN 4x -> grade_color(L1)',
  chain_steps_s: { split: 2.4, sdxl: 18.2, i2v: 192.5, rife: 21.0, upscale: 46.8, grade: 3.1 }
})
writeText(
  path.join(s0Dir, 'report.md'),
  '# Issue-19 · B 轨 S0 咖啡产品实拍重构报告\n\n取样：t=0.5 ~ 4.5s\n\n- 链路：PySceneDetect → SDXL 重绘 → LTX-2B I2V → RIFE → Real-ESRGAN\n- 结论：SSIM 达标，早期噪声门禁未冻结。\n'
)
writeText(path.join(s0Dir, 'metrics2.csv'), buildCsv(36, 480, 1.92, 19.4))

const s1Dir = path.join(DATA, 'issue-19', 'b-track-s1')
const s1Out = path.join(s1Dir, 'out')
const s1Mp4 = path.join(s1Out, 's1_enhanced.mp4')
makeVideo(s1Mp4, { color: '#14262c', accent: '#0ea5e9', duration: 4, fps: 30, width: 720, height: 1280, eq: 'eq=contrast=1.1:saturation=1.08' })
writeJson(path.join(s1Out, 'summary.json'), {
  task_id: 'T-B-019-S1',
  aggregate: {
    B1_ssim_mean: { mean: 0.914, worst: 0.858 },
    B2_net_gain_vs_baseline_ratio: { mean: 2.14, worst: 1.76 },
    B2_noise_change_pct: { mean: 23.8, worst: 26.4 },
    B3_ghost_ratio_median: { mean: 0.98, worst: 1.24 },
    B3_tear_frac_mean: { mean: 0.018, worst: 0.036 },
    B3_overshoot_frac_mean: { mean: 0.0691, worst: 0.112 },
    B3_skin_dE_pre_grade_mean: { mean: 2.34, worst: 3.41 }
  },
  gates: {
    'B1_ssim>=0.80': true,
    'B2_net_gain>=1.5x': true,
    'B2_noise<=+15%': false,
    'B3_ghost<=1.5': true,
    'B3_tear<=10%': true,
    'B3_overshoot<=35%': true,
    'B3_skin_dE_pre_grade<=5': true
  },
  clip: { duration_s: 4.0, fps: 30, width: 720, height: 1280, crf: 16 },
  chain: 'PySceneDetect -> Qwen2-VL -> SDXL -> LTX-2B -> RIFE -> Real-ESRGAN -> grade_color',
  chain_steps_s: { probe: 1.8, vlm: 9.4, sdxl: 16.5, i2v: 174.0, rife: 19.3, upscale: 42.1, grade: 2.9 }
})
writeText(
  path.join(s1Dir, 'report.md'),
  '# Issue-19 · B 轨 S1 咖啡品牌广告增强链验证\n\n取样：t=1.0 ~ 5.0s\n\n- 7 项判据通过 6 项；仅平坦区噪声 +23.8% 超出 +15% 阈值。\n'
)
writeText(path.join(s1Out, 'metrics.csv'), buildCsv(42, 510, 2.15, 23.8))
writeJson(path.join(s1Out, 'ai_repair_report.json'), {
  input: path.relative(DATA, origMov),
  output: path.relative(DATA, s1Mp4),
  output_sha256: sha256(s1Mp4),
  repaired: true,
  strategy: 'temporal_denoise_v3 + grade_color(ad_teal_orange)',
  summary: '已应用时域降噪 v3 并挂载 ad_teal_orange 调色 LUT，肤色 ΔE 降至 2.34。',
  unverified: []
})

const s2Dir = path.join(DATA, 'issue-19', 'b-track-s2')
const s2Out = path.join(s2Dir, 'out')
const s2Mp4 = path.join(s2Out, 's2_graded.mp4')
makeVideo(s2Mp4, { color: '#1b261d', accent: '#30a14e', duration: 5, fps: 30, width: 720, height: 1280, eq: 'eq=contrast=1.05:saturation=1.02' })
writeJson(path.join(s2Out, 'summary.json'), {
  task_id: 'T-B-019-S2',
  verdict: 'PASS',
  aggregate: {
    B1_ssim_mean: { mean: 0.936, worst: 0.891 },
    B2_net_gain_vs_baseline_ratio: { mean: 2.32, worst: 1.94 },
    B2_noise_change_pct: { mean: 11.2, worst: 14.1 },
    B3_ghost_ratio_median: { mean: 0.84, worst: 1.11 },
    B3_tear_frac_mean: { mean: 0.012, worst: 0.029 },
    B3_overshoot_frac_mean: { mean: 0.054, worst: 0.088 },
    B3_skin_dE_pre_grade_mean: { mean: 1.92, worst: 2.85 }
  },
  gates: {
    'B1_ssim>=0.80': true,
    'B2_net_gain>=1.5x': true,
    'B2_noise<=+15%': true,
    'B3_ghost<=1.5': true,
    'B3_tear<=10%': true,
    'B3_overshoot<=35%': true,
    'B3_skin_dE_pre_grade<=5': true
  },
  clip: { duration_s: 5.0, fps: 30, width: 720, height: 1280, crf: 16 },
  chain: 'PySceneDetect -> Qwen2-VL -> Profile(vlog_warm_film) -> SDXL -> LTX-2B -> RIFE -> Real-ESRGAN -> grade_color',
  chain_steps_s: { probe: 1.6, vlm: 8.8, sdxl: 15.9, i2v: 168.4, rife: 18.2, upscale: 39.5, grade: 2.7 },
  look: { profile: 'vlog_warm_film', lut: 'looks/vlog_warm_film.cube', match_ref: 'shot_001', match_strength: 0.8 }
})
writeText(
  path.join(s2Dir, 'report.md'),
  '# Issue-19 · B 轨 S2 人物 Vlog 暖胶片成片（全项通过）\n\n取样：t=0.2 ~ 5.2s\n\n- 全部 7 项 QC 门禁均通过，色彩 p95 ΔE2000 = 2.85 ≤ 6。\n'
)
writeText(path.join(s2Out, 'metrics.csv'), buildCsv(48, 530, 2.31, 11.2))
writeText(path.join(s2Dir, 'worker.log'), '2026-11-12T10:14:02Z [orchestrator] stage=D model=ltx-2b lock=acquired mem_free=39.4GB\n2026-11-12T10:16:51Z [orchestrator] stage=E grade_color look=vlog_warm_film deltaE_p95=2.85 PASS\n2026-11-12T10:17:10Z [archive] synced to NAS /Volume2/KexLabs/40_deliverables/s2_graded.mp4\n')

// 3. Project status & task plan
const now = new Date()
const dayIso = (offsetDays) => new Date(now.getTime() + offsetDays * 86400000).toISOString().slice(0, 10)
const nowIso = now.toISOString()

writeJson(path.join(DATA, '.opencode', 'state', 'project-status.json'), {
  updated_at: nowIso,
  updated_by: 'seed-mastermind-plan',
  milestones: [
    {
      id: 'M0',
      name: 'M0 · Phase 0.5 I2V 闸门与硬件锁定',
      state: 'done',
      detail: 'Mac Studio M5 Max 64GB（48GB Metal）+ LTX-2B L0~L3 验证通过',
      evidence: ['issue-19/b-track-s2/out/summary.json'],
      rails: [
        { rail: 'A', state: 'pass', detail: 'SDXL + Qwen2-VL 关键帧语义打标跑通' },
        { rail: 'B', state: 'pass', detail: 'LTX-2B + RIFE + Real-ESRGAN 链式 3×49f 通过' }
      ]
    },
    {
      id: 'M1',
      name: 'M1 · 六阶段单镜头全链路与调色',
      state: 'in_progress',
      detail: 'Stage A→F 串行独占内存 + grade_color 跨镜头 ΔE2000 收口中',
      rails: [
        { rail: 'A', state: 'conditional_pass', detail: 'B2 语义 → Profile 映射已上线，待扩充 Vlog 模板' },
        { rail: 'B', state: 'in_progress', detail: 'S1 平坦区噪声优化验证中，S2 已全过' }
      ]
    },
    {
      id: 'M2',
      name: 'M2 · Multi-Agent 决策编排与无人值守',
      state: 'pending',
      detail: 'L3 orchestrator.py + Redis Stream 分队列与单项锁联调'
    }
  ],
  now: [
    { task: 'T-PIPE-104 调色链路 grade_color', detail: 'S2 成片跨镜头 ΔE2000 p95=2.85 达标，正在回归 S1', owner: 'seed-video-dev' },
    { task: 'T-ORCH-108 L3 导演/摄影/调色角色 Profile 映射', detail: '阶段 B2 语义到 ad_teal_orange / vlog_warm_film 确定性挂载', owner: 'seed-mastermind-plan' }
  ],
  missing: [
    { item: 'NAS Gitea & Redis Stream 实机联调', blocked_by: '待接回本地 Mac Studio / NAS 内网', why: '云端沙盒无法直连 192.168.100.2', impact: '当前使用本地文件模式模拟' },
    { item: 'Audio Spike（Kokoro-82M + Faster-Whisper）', blocked_by: 'T-AUDIO-112 未排期', why: '尚未完成 MPS 内存峰值实测', impact: '阶段 F 暂用音轨占位' }
  ],
  verdict_rules: { pass: '7/7 硬门禁全部通过', conditional: '历史口径或人工覆核待定', fail: '任一硬门禁未通过' },
  eta: { best_case_days: 3, base_case_days: 5, worst_case_days: 9, assumption: 'Phase 1 六阶段工具已闭环，剩余 Audio 与 NAS 守护化收口' }
})

writeJson(path.join(DATA, '.opencode', 'state', 'tasks.json'), {
  updated_at: nowIso,
  timezone: 'Asia/Shanghai',
  note: 'Kex Labs V4.2 研发与视频流水线验收计划（Option C 预览集）',
  milestones: [
    { id: 'M0', label: 'M0 · I2V 闸门通过', at: dayIso(-4), state: 'done' },
    { id: 'M1', label: 'M1 · 六阶段闭环', at: dayIso(1), state: 'in_progress' },
    { id: 'M2', label: 'M2 · 无人值守交付', at: dayIso(5), state: 'pending' }
  ],
  tasks: [
    { id: 'T-PIPE-101', title: '阶段 A · PySceneDetect 镜头切分与抽帧工具', owner: 'seed-video-dev', rail: '双轨', status: 'done', start: dayIso(-5), end: dayIso(-3), progress: 100, evidence: 'issue-19/b-track-s2/report.md' },
    { id: 'T-PIPE-102', title: '阶段 B · Qwen2-VL-7B 关键帧语义 JSON 契约', owner: 'seed-dev', rail: 'A', status: 'done', start: dayIso(-4), end: dayIso(-2), progress: 100 },
    { id: 'T-PIPE-103', title: '阶段 B2 · 语义 → Director Profile 确定性挂载', owner: 'seed-solution-architect', rail: '双轨', status: 'done', start: dayIso(-3), end: dayIso(-1), progress: 100 },
    { id: 'T-PIPE-104', title: '阶段 E · grade_color 4 套 LUT 与 ΔE2000 校验', owner: 'seed-video-dev', rail: 'B', status: 'running', start: dayIso(-2), end: dayIso(1), progress: 78, evidence: 'issue-19/b-track-s2/out/summary.json' },
    { id: 'T-ORCH-105', title: '阶段 D · LTX-2B 候选片段多采样筛选', owner: 'seed-task-runner', rail: 'B', status: 'running', start: dayIso(-1), end: dayIso(2), progress: 55 },
    { id: 'T-AUDIO-106', title: '阶段 F · Kokoro-82M TTS + 环境底噪混音', owner: 'seed-dev', rail: 'A', status: 'blocked', start: dayIso(0), end: dayIso(3), progress: 20, blocked_by: '等待 MPS 音频模型内存峰值压测' },
    { id: 'T-WEB-107', title: '前端可视化 · 单片六阶段节点与 Agent 角色轨迹', owner: 'seed-ui-dev', rail: '双轨', status: 'pending', start: dayIso(1), end: dayIso(4), progress: 10 },
    { id: 'T-OPS-108', title: 'NAS RAID1 归档与 Redis Stream 断点续跑压测', owner: 'seed-acceptance-tester', rail: '双轨', status: 'pending', start: dayIso(2), end: dayIso(5), progress: 0 }
  ],
  eta: { best_case_days: 3, base_case_days: 5, worst_case_days: 9, current_phase: 'Phase 1 · 阶段 E/F 收口', next_gate: 'M1 · 六阶段端到端闭环' }
})

writeText(path.join(DATA, '.opencode', 'state', 'TASK.md'), '# Kex Labs Master Task\n- M1 六阶段串行闭环推进中\n')
writeJson(path.join(DATA, '.opencode', 'state', 'SUBAGENT_STATUS.json'), {
  agents: [
    { id: 'seed-video-dev', state: 'running', task: 'T-PIPE-104' },
    { id: 'seed-task-runner', state: 'running', task: 'T-ORCH-105' },
    { id: 'seed-ui-dev', state: 'idle', task: 'T-WEB-107' }
  ]
})

// 4. Local Issues for /issues
const issues = [
  { num: 101, title: '阶段 E 平坦区噪声 +23.8% 超出 +15% 阈值排查', owner: 'seed-video-dev', rail: 'B', priority: 'P0', status: 'doing', description: 'b-track-s1 在 Real-ESRGAN 4x 超分后平坦区域高频噪声抬升，需对比 lanczos 预平滑与时域降噪权重。' },
  { num: 102, title: '新增「导演 / 摄影 / 调色」角色处理轨迹视图与视频节点回放', owner: 'seed-ui-dev', rail: '双轨', priority: 'P1', status: 'open', description: '用户希望在同一页面直观看到一条视频经过 Phase A→F 每个渲染节点与不同角色 Agent 的决策差异和输出画面。' },
  { num: 103, title: '活人感 5 维客观指标接入 quality_check 门禁', owner: 'seed-acceptance-tester', rail: 'B', priority: 'P1', status: 'done', description: '已将镜头时长标准差 ≥0.6s、音频动态范围 >8 LU 与皮肤高频纹理检查写入 S2 验收单。' }
]
for (const iss of issues) {
  const dir = path.join(DATA, `issue-${iss.num}`)
  writeJson(path.join(dir, 'issue.json'), {
    title: iss.title,
    description: iss.description,
    owner: iss.owner,
    rail: iss.rail,
    priority: iss.priority,
    status: iss.status,
    created_at: nowIso,
    updated_at: nowIso
  })
  writeText(path.join(dir, 'README.md'), `# ${iss.title}\n\n${iss.description}\n`)
}

// 5. KEX_REPO_ROOT (Flow + Pipeline + Contract + Media Artifacts)
const job1 = '20261112_coffee_ad_001'
const job1Dir = path.join(KEX, 'jobs', job1)
makePng(path.join(job1Dir, 'frames', 'shot_01.png'), { color: '#2b211a', accent: '#d97706', boxY: 160 })
makePng(path.join(job1Dir, 'frames', 'shot_02.png'), { color: '#1e293b', accent: '#38bdf8', boxY: 200 })
makePng(path.join(job1Dir, 'rendered', 'shot_01_sdxl.png'), { color: '#3b2416', accent: '#f59e0b', boxY: 150 })
makePng(path.join(job1Dir, 'rendered', 'shot_02_sdxl.png'), { color: '#132a3e', accent: '#0ea5e9', boxY: 190 })
makeVideo(path.join(job1Dir, 'clips', 'shot_01_ltx.mp4'), { color: '#291c14', accent: '#f59e0b', duration: 3, fps: 24, width: 768, height: 512 })
makeVideo(path.join(job1Dir, 'graded', 'shot_01_graded.mp4'), { color: '#18242c', accent: '#fb923c', duration: 3, fps: 30, width: 768, height: 512 })
makeVideo(path.join(job1Dir, 'final', 'coffee_ad_master.mp4'), { color: '#102028', accent: '#f97316', duration: 4, fps: 30, width: 768, height: 512 })

writeText(
  path.join(KEX, 'prompts', 'ad_teal_orange_v1.txt'),
  '[Director Profile: ad_teal_orange v1]\nSubject fidelity lock: espresso cup ceramic texture, warm rim light, subtle steam wisps, shallow DOF 50mm f/1.8, teal-orange commercial look, natural handheld micro-motion.\nNegative: plastic skin, oversharpened halo, uniform pan, watermark.\n'
)

writeJson(path.join(KEX, 'state', `${job1}.json`), {
  schema_version: '1.1',
  job_id: job1,
  stage: 'F',
  updated_at: nowIso,
  probe: { width: 1920, height: 1080, fps: 30, duration_s: 15.2, codec: 'h264', bitrate_mbps: 14.6 },
  cold_warm: { mode: 'warm', model_unload_verified: true, free_mem_gb: 38.6 },
  semantics: {
    typology: 'ad_product',
    subject: { kind: 'product', name: '手冲咖啡杯与黄铜滤杯', count: 1 },
    lighting: { direction: 'side', quality: 'soft', time: 'golden_hour', temp_k: 4200 },
    motion: { camera: 'handheld_micro', subject: 'steam_rise', intensity: 0.25 },
    confidence: 0.91
  },
  profile: {
    name: 'ad_teal_orange',
    source: 'policy:typology_map',
    confidence: 0.91,
    reason: 'typology=ad_product → 广告商业（青橙高对比）',
    prompt: { path: 'prompts/ad_teal_orange_v1.txt', version: 'pt-v1.4' }
  },
  shots: [
    { shot_id: 1, start: 0.0, end: 3.8, duration_s: 3.8 },
    { shot_id: 2, start: 3.8, end: 8.2, duration_s: 4.4 },
    { shot_id: 3, start: 8.2, end: 11.4, duration_s: 3.2 },
    { shot_id: 4, start: 11.4, end: 15.2, duration_s: 3.8 }
  ],
  frames: [
    { shot_id: 1, frame_ts: 1.4, path: `jobs/${job1}/frames/shot_01.png` },
    { shot_id: 2, frame_ts: 5.6, path: `jobs/${job1}/frames/shot_02.png` }
  ],
  rendered: [
    { shot_id: 1, output: `jobs/${job1}/rendered/shot_01_sdxl.png`, prompt: 'Commercial product macro of ceramic coffee cup, golden hour side keylight, natural film grain', negative: 'plastic, CGI, oversharpened', seed: 20261112 },
    { shot_id: 2, output: `jobs/${job1}/rendered/shot_02_sdxl.png`, prompt: 'Pour-over kettle silhouette with warm specular highlight, shallow DOF 50mm', negative: 'blurry rim, distorted handle', seed: 20261113 }
  ],
  clips: [
    { shot_id: 1, output: `jobs/${job1}/clips/shot_01_ltx.mp4`, prompt: 'Gentle rising steam and subtle handheld camera breathing, 24fps', negative: 'warping, flicker', seed: 20261112 }
  ],
  graded: [
    { shot_id: 1, output: `jobs/${job1}/graded/shot_01_graded.mp4` }
  ],
  audio: { mix: `jobs/${job1}/final/coffee_ad_master.mp4` },
  stages: {
    A: { status: 'done', duration_s: 4.2, updated_at: nowIso, tools: { probe_video: { status: 'done', duration_ms: 420, attempts: 1 }, split_shots: { status: 'done', duration_ms: 1950, attempts: 1 }, extract_frames: { status: 'done', duration_ms: 1830, attempts: 1, artifact: `jobs/${job1}/frames/shot_01.png` } } },
    B: { status: 'done', duration_s: 11.6, updated_at: nowIso, tools: { describe_frames: { status: 'done', duration_ms: 11600, attempts: 1, cached: false } } },
    C: { status: 'done', duration_s: 28.4, updated_at: nowIso, tools: { render_frames: { status: 'done', duration_ms: 28400, attempts: 1, artifact: `jobs/${job1}/rendered/shot_01_sdxl.png` } } },
    D: { status: 'done', duration_s: 184.5, updated_at: nowIso, tools: { generate_clips: { status: 'done', duration_ms: 184500, attempts: 2, artifact: `jobs/${job1}/clips/shot_01_ltx.mp4` } } },
    E: { status: 'done', duration_s: 52.1, updated_at: nowIso, tools: { interpolate: { status: 'done', duration_ms: 16200, attempts: 1 }, upscale: { status: 'done', duration_ms: 33100, attempts: 1 }, grade_color: { status: 'done', duration_ms: 2800, attempts: 1, artifact: `jobs/${job1}/graded/shot_01_graded.mp4` } } },
    F: { status: 'done', duration_s: 9.8, updated_at: nowIso, tools: { assemble: { status: 'done', duration_ms: 6400, attempts: 1, artifact: `jobs/${job1}/final/coffee_ad_master.mp4` }, quality_check: { status: 'done', duration_ms: 3400, attempts: 1 } } }
  },
  quality_gate: { verdict: 'PASS', color_p95_de2000: 2.85, human_pacing_std_s: 0.72 },
  artifacts: { master: `jobs/${job1}/final/coffee_ad_master.mp4` }
})

writeText(
  path.join(KEX, 'decisions', `${job1}.jsonl`),
  [
    JSON.stringify({ at: new Date(now.getTime() - 320000).toISOString(), role: '摄影 / split_shots', kind: 'threshold', summary: '检测为快节奏产品广告，PySceneDetect 阈值设 24.0（保留 4 镜变速时长 3.2–4.4s）' }),
    JSON.stringify({ at: new Date(now.getTime() - 280000).toISOString(), role: '导演 / select_profile', kind: 'policy:typology_map', summary: 'Qwen2-VL 识别 ad_product (0.91) → 挂载 ad_teal_orange Profile 与 pt-v1.4 提示词' }),
    JSON.stringify({ at: new Date(now.getTime() - 210000).toISOString(), role: '编剧 / render_frames', kind: 'prompt_rewrite', summary: 'Shot 1-2 注入陶瓷反光约束与反塑料负向词，SDXL 独占 8GB 一次通过' }),
    JSON.stringify({ at: new Date(now.getTime() - 95000).toISOString(), role: '后期 / generate_clips', kind: 'candidate_pick', summary: 'Shot 1 采样 2 次，弃用 clip_01（32 帧边缘微形变），选中 clip_02 (SSIM 0.962)' }),
    JSON.stringify({ at: new Date(now.getTime() - 35000).toISOString(), role: '调色 / grade_color', kind: 'color_match', summary: '以 shot_01 为基准完成 L1+L2+L3 匹配，跨镜 ΔE2000 p95=2.85 ≤ 6 放行' })
  ].join('\n') + '\n'
)

const job2 = '20261113_vlog_cafe_002'
const job2Dir = path.join(KEX, 'jobs', job2)
makePng(path.join(job2Dir, 'frames', 'shot_01.png'), { color: '#26201c', accent: '#eab308', boxY: 180 })
makePng(path.join(job2Dir, 'rendered', 'shot_01_sdxl.png'), { color: '#2e221b', accent: '#f97316', boxY: 170 })

writeJson(path.join(KEX, 'state', `${job2}.json`), {
  schema_version: '1.1',
  job_id: job2,
  stage: 'D',
  updated_at: nowIso,
  probe: { width: 1080, height: 1920, fps: 30, duration_s: 18.6, codec: 'hevc', bitrate_mbps: 18.2 },
  cold_warm: { mode: 'warm', model_unload_verified: true, free_mem_gb: 31.2 },
  semantics: { typology: 'vlog', subject: { kind: 'person', name: '探店咖啡师手部拉花特写', count: 1 }, confidence: 0.87 },
  profile: { name: 'vlog_warm_film', source: 'policy:typology_map', confidence: 0.87, reason: 'typology=vlog → 人物 Vlog 暖胶片' },
  shots: [
    { shot_id: 1, start: 0.0, end: 4.1, duration_s: 4.1 },
    { shot_id: 2, start: 4.1, end: 7.4, duration_s: 3.3 }
  ],
  frames: [{ shot_id: 1, frame_ts: 1.8, path: `jobs/${job2}/frames/shot_01.png` }],
  rendered: [{ shot_id: 1, output: `jobs/${job2}/rendered/shot_01_sdxl.png`, prompt: 'Warm 35mm film grain portrait of latte art pour, soft window light', seed: 20261120 }],
  stages: {
    A: { status: 'done', duration_s: 3.9, updated_at: nowIso, tools: { probe_video: { status: 'done', duration_ms: 390, attempts: 1 }, split_shots: { status: 'done', duration_ms: 1740, attempts: 1 } } },
    B: { status: 'done', duration_s: 9.2, updated_at: nowIso, tools: { describe_frames: { status: 'done', duration_ms: 9200, attempts: 1 } } },
    C: { status: 'done', duration_s: 21.0, updated_at: nowIso, tools: { render_frames: { status: 'done', duration_ms: 21000, attempts: 1, artifact: `jobs/${job2}/rendered/shot_01_sdxl.png` } } },
    D: { status: 'running', duration_s: 64.0, updated_at: nowIso, tools: { generate_clips: { status: 'running', duration_ms: 64000, attempts: 1 } } },
    E: { status: 'pending', duration_s: null, updated_at: null, tools: { interpolate: { status: 'pending', duration_ms: null }, upscale: { status: 'pending', duration_ms: null }, grade_color: { status: 'pending', duration_ms: null } } },
    F: { status: 'pending', duration_s: null, updated_at: null, tools: { assemble: { status: 'pending', duration_ms: null } } }
  }
})
writeText(
  path.join(KEX, 'decisions', `${job2}.jsonl`),
  [
    JSON.stringify({ at: new Date(now.getTime() - 90000).toISOString(), role: '导演 / select_profile', kind: 'policy:typology_map', summary: '识别 vlog 场景 → 挂载 vlog_warm_film，开启轻微手持呼吸与 3% 胶片颗粒' }),
    JSON.stringify({ at: new Date(now.getTime() - 30000).toISOString(), role: 'orchestrator / lock', kind: 'mem_guard', summary: '已卸载 Ollama + SDXL，可用 Metal 31.2GB，获取 lock:clip:shot_01 进入 LTX-2B' })
  ].join('\n') + '\n'
)

// ComfyUI API-format workflows for /pipeline DAG
writeJson(path.join(KEX, 'workflows', 'ltxv_i2v_v1.json'), {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx-video-2b-v0.9.5.safetensors' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'shot_01_sdxl.png' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '__POSITIVE__', clip: ['1', 1] } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE__', clip: ['1', 1] } },
  '5': { class_type: 'LTXVConditioning', inputs: { positive: ['3', 0], negative: ['4', 0], frame_rate: 24 } },
  '7': { class_type: 'LTXVImgToVideo', inputs: { positive: ['5', 0], negative: ['5', 1], vae: ['1', 2], image: ['2', 0], width: 768, height: 512, length: 73, batch_size: 1 } },
  '8': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2], seed: 20261112, steps: 24, cfg: 3.5, sampler_name: 'euler', scheduler: 'simple', denoise: 0.92 } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } },
  '10': { class_type: 'VHS_VideoCombine', inputs: { images: ['9', 0], frame_rate: 24, format: 'video/h264-mp4', filename_prefix: 'ltx_clip' } }
})

writeJson(path.join(KEX, 'workflows', 'sdxl_keyframe_v1.json'), {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '__POSITIVE__', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE__', clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 20261112, steps: 28, cfg: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1.0 } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'keyframe_sdxl' } }
})

// Policy thresholds & dual-track gate docs
writeJson(path.join(KEX, 'policy', 'quality_thresholds.json'), {
  checks: {
    B1_ssim_mean: { label: 'B1 · 保真 SSIM', op: '>=', threshold: 0.8, unit: '', hard: true },
    B2_net_gain_vs_baseline_ratio: { label: 'B2 · 锐度净增益', op: '>=', threshold: 1.5, unit: '×', hard: true },
    B2_noise_change_pct: { label: 'B2 · 平坦区噪声', op: '<=', threshold: 15, unit: '%', hard: true },
    B3_ghost_ratio_median: { label: 'B3 · 插帧鬼影比', op: '<=', threshold: 1.5, unit: '', hard: true },
    B3_tear_frac_mean: { label: 'B3 · 撕裂占比', op: '<=', threshold: 0.1, unit: '', hard: true },
    B3_overshoot_frac_mean: { label: 'B3 · 超分过冲', op: '<=', threshold: 0.35, unit: '', hard: true },
    B3_skin_dE_pre_grade_mean: { label: 'B3 · 肤色 ΔE', op: '<=', threshold: 5, unit: '', hard: true }
  }
})

writeText(
  path.join(KEX, 'docs', 'plan', 'dual-track-v4.md'),
  [
    '# Dual-Track Gate Contract V4.2',
    '',
    '| Gate | 名称 | 通过标准 |',
    '|---|---|---|',
    '| A1 | 关键帧抽检可用率 | ≥ 70% |',
    '| A2 | 跨镜头一致性偏差 | ≤ 2 |',
    '| B1 | 保真 SSIM 均值 | ≥ 0.80 |',
    '| B2 | 锐度净增益（vs Lanczos） | ≥ 1.5× |',
    '| B3 | RIFE 插帧鬼影比 | ≤ 1.5 |',
    '| B4 | 调色 ΔE2000 p95 | ≤ 6 |',
    '| B5 | 活人感镜头时长标准差 | ≥ 0.6s |'
  ].join('\n') + '\n'
)

writeJson(path.join(KEX, 'jobs', job1, 'render_report.json'), {
  job_id: job1,
  memory: { wired_limit_gb: 48.0, peak_metal_gb: 26.4, unload_verified: true }
})
writeJson(path.join(KEX, 'reports', `${job1}.json`), {
  job_id: job1,
  probe: { width: 1920, height: 1080, fps: 30, duration_s: 15.2 },
  assemble_report: { clips: 4, audio_lufs: -14.2, color_p95_de2000: 2.85, output_bytes: 28451200 }
})

// Queue dirs & logs
for (const sub of ['inbox', 'inbox-running', 'inbox-done', 'inbox-failed', 'inbox-rejected']) {
  ensureDir(path.join(KEX, 'jobs', sub))
}
writeJson(path.join(KEX, 'jobs', 'inbox', '20261113_doc_factory_003.json'), { job_id: '20261113_doc_factory_003', profile: 'doc_neutral' })
writeJson(path.join(KEX, 'jobs', 'inbox-running', `${job2}.json`), { job_id: job2, stage: 'D' })
writeJson(path.join(KEX, 'jobs', 'inbox-done', `${job1}.json`), { job_id: job1, verdict: 'PASS' })

writeText(
  path.join(KEX, 'state', '.locks', 'events.jsonl'),
  [
    JSON.stringify({ at: new Date(now.getTime() - 120000).toISOString(), lock: 'kex_pipeline.lock', event: 'acquire', job_id: job2, pid: 41208 }),
    JSON.stringify({ at: new Date(now.getTime() - 30000).toISOString(), lock: 'lock:clip:shot_01', event: 'heartbeat', job_id: job2, ttl_s: 1800 })
  ].join('\n') + '\n'
)

writeText(
  path.join(LOGS, 'worker-launchd-stdout.log'),
  [
    `[${new Date(now.getTime() - 180000).toISOString()}] INFO orchestrator: unloaded ollama keep_alive=0, free Metal 38.6GB`,
    `[${new Date(now.getTime() - 90000).toISOString()}] INFO stage=C render_frames job=${job2} sdxl_v1 finished in 21.0s`,
    `[${new Date(now.getTime() - 25000).toISOString()}] INFO stage=D generate_clips job=${job2} shot=1 model=ltx-video-2b running (frame 28/73)`
  ].join('\n') + '\n'
)

// 6. Studio Briefs & Video Scripts (/api/studio/briefs)
const BRIEFS_DIR = path.join(DATA, 'studio', 'briefs')
writeJson(path.join(BRIEFS_DIR, 'brief_coffee_ad_001.json'), {
  id: 'brief_coffee_ad_001',
  idea: '清晨自然侧逆光下的手冲精品咖啡广告：展现黄铜滤杯、陶瓷杯釉面细节与升腾热气，传递温暖克制的手工质感。',
  audience: '精品咖啡消费者与品牌视觉团队',
  duration_s: 15,
  aspect: '16:9',
  tone: '克制温暖 · 青橙商业质感',
  references: [`jobs/${job1}/frames/shot_01.png`],
  polished: {
    logline: '晨光穿过窗棂，一只手工陶杯与缓缓注水的铜壶，在15秒呼吸节奏里完成温度与风味的具象表达。',
    script:
      '【00:00-00:03.8 镜1 · 定场】旁白（低沉温润）：「好风味从不赶时间。」画面：侧逆暖光落于深褐陶杯边缘，细腻白汽贴杯壁缓缓升起。\n【00:03.8-00:08.2 镜2 · 注水】旁白：「88度水流绕杯三圈，唤醒焙烤豆香。」画面：手部平稳绕圈注水，粉层膨胀出细密金黄油脂。\n【00:08.2-00:11.4 镜3 · 器物】无旁白（留白环境音：水滴与轻风）。画面：黄铜滤杯微距质感特写，焦外柔化。\n【00:11.4-00:15.2 镜4 · 落版】旁白：「这一杯，敬慢下来的清晨。」画面：杯身轻微手持呼吸摇移，青橙暗调衬托暖金高光收尾。',
    style: 'ad_teal_orange · 50mm f/1.8 · 轻微胶片颗粒与自然手持微颤',
    shots: [
      { no: 1, duration_s: 3.8, camera: '微距固定 · 极轻手持呼吸感', prompt: '手工陶土咖啡杯置于木桌，4200K 黄金侧光勾勒杯沿暖调高光，天然蒸汽轻缓上升' },
      { no: 2, duration_s: 4.4, camera: '中景慢跟 · 手部顺时针绕圈', prompt: '手冲细口铜壶缓缓注入热水，咖啡粉层饱满鼓起，环境温润柔和' },
      { no: 3, duration_s: 3.2, camera: '特写浅景深推镜 · 50mm', prompt: '黄铜滤杯边缘反光与滴落咖啡液特写，青橙影调形成高质感对比' },
      { no: 4, duration_s: 3.8, camera: '缓缓后拉收尾定格', prompt: '完整手冲桌面定场画面，清晨逆光通透自然，右下留出品牌视觉呼吸空间' }
    ]
  },
  questions_pending: [],
  status: 'confirmed',
  version: 2,
  created_at: new Date(now.getTime() - 3600000).toISOString(),
  updated_at: nowIso
})

writeJson(path.join(BRIEFS_DIR, 'brief_vlog_cafe_002.json'), {
  id: 'brief_vlog_cafe_002',
  idea: '记录街角咖啡馆清晨开店：咖啡师推开木门、开机磨豆、拉花与第一缕阳光照进吧台的 Vlog 短片。',
  audience: '城市生活方式与探店短视频受众',
  duration_s: 18,
  aspect: '16:9',
  tone: '温暖日系胶片 · 生活呼吸感',
  references: [`jobs/${job2}/frames/shot_01.png`],
  polished: {
    logline: '八点半的街角阳光刚过窗台，一杯拉花拿铁宣告今日营业正式开始。',
    script:
      '【00:00-00:04.2 镜1 · 开店】环境音：木门风铃轻响。旁白：「城市还没完全醒来，磨豆机已经先开始了工作。」\n【00:04.2-00:08.8 镜2 · 萃取】画面：咖啡师手腕轻晃拉花缸，牛奶丝滑融入浓缩液形成郁金香纹理。\n【00:08.8-00:13.2 镜3 · 窗边光影】画面：晨光斜射吧台杯具，自然留白 1.2 秒呼吸间隔。\n【00:13.2-00:18.6 镜4 · 递出】旁白：「早安，今天的第一杯已经准备好了。」',
    style: 'vlog_warm_film · 35mm f/2.0 · 温暖低饱和胶片感',
    shots: [
      { no: 1, duration_s: 4.2, camera: '肩扛手持轻移入吧台', prompt: '木门轻推，清晨自然天光落入咖啡馆吧台，保留真实颗粒感' },
      { no: 2, duration_s: 4.6, camera: '手部45度俯拍特写', prompt: '咖啡师稳健手部操作拉花缸倾倒奶泡，郁金香纹理清晰自然' },
      { no: 3, duration_s: 4.4, camera: '慢速横摇 · 窗边逆光', prompt: '玻璃杯与绿植在晨光下投出长影，保持温暖低饱和胶片影调' },
      { no: 4, duration_s: 5.4, camera: '定格微推 · 主视角递杯', prompt: '热拿铁递向吧台桌面，蒸汽轻散，画面温暖柔和' }
    ]
  },
  questions_pending: [],
  status: 'draft',
  version: 1,
  created_at: new Date(now.getTime() - 1800000).toISOString(),
  updated_at: nowIso
})

console.log('Option C preview dataset ready.')
