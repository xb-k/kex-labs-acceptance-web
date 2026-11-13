import type { SnapshotRule } from './types'

/**
 * #106：QC 门禁的解释层。
 *
 * 只做展示派生：把后端 `rules` 的判定翻译成「结论 + 白话 + 建议动作」。
 * 不重算阈值、不改 `actual` / `verdict`、不把专业字段藏起来。
 * 未知 ruleId 一律回退中性文案，不猜测指标含义。
 */

export type VerdictKind = 'pass' | 'attention' | 'fail' | 'insufficient'

export type RuleExplanation = {
  /** 一句话白话：这是什么 / 怎么看。 */
  plain: string
  /** 为什么重要：超阈值或缺失意味着什么。 */
  why: string
  /** 建议动作：与项目真实流程一致（B 轨重跑 / 调参 / 换素材 / 联系维护者）。 */
  action: string
}

export type VerdictSummary = {
  kind: VerdictKind
  label: '通过' | '需要注意' | '未通过' | '数据不足'
  plain: string
  counts: { pass: number; fail: number; unavailable: number; total: number }
}

const UNKNOWN: RuleExplanation = {
  plain: '这项规则暂无白话说明。',
  why: '页面只展示后端返回的规则名、阈值和判定，不推断未登记指标的含义。',
  action: '如需解读，请联系项目维护者确认规则含义后再处理。'
}

/** 与 `/api/qc/:id` 的 rules 对齐；只登记本页实际出现的 7 条 policy 规则。 */
export const RULE_EXPLANATIONS: Record<string, RuleExplanation> = {
  skin_texture_energy: {
    plain: '皮肤区域的高频细节强度，数值越大通常越有质感。',
    why: '低于阈值多半是磨皮过度、降噪过强，或源片本身发糊。',
    action: '回 B 轨重跑，调低降噪/磨皮强度，或换更清晰的源片。'
  },
  bgm_loop_peak_8s: {
    plain: '背景音乐每 8 秒重复一次的相似度，越低越听不出循环。',
    why: '高于阈值说明 BGM 循环感明显，成片听感容易单调。',
    action: '换更长的 BGM，或让剪辑点错开循环位置后重跑。'
  },
  shot_duration_stddev_s: {
    plain: '各个镜头时长的波动大小，单位是秒。',
    why: '太小会像幻灯片，太大则节奏忽快忽慢。',
    action: '调整分镜时长或剪辑节奏后重跑；单镜头素材可忽略此项。'
  },
  motion_variance: {
    plain: '画面运动幅度的变化，越大运动越丰富。',
    why: '太低接近静帧，太高容易晃眼、影响观看。',
    action: '换运动更自然的素材，或调整运镜/帧间插值参数后重跑。'
  },
  audio_dynamic_range_lu: {
    plain: '声音最响与最轻之间的差距，单位是 LU。',
    why: '太小声音发平，太大则忽大忽小、需要频繁调音量。',
    action: '做响度归一或压缩后重跑，或换动态更合适的音频素材。'
  },
  color_mean_delta_e2000: {
    plain: '整片平均色彩偏差，ΔE 越小越接近原片。',
    why: '偏差大说明调色跑偏，或前后镜头白平衡不一致。',
    action: '回 B 轨重跑并复核 LUT / 白平衡，或换一版调色参数。'
  },
  color_p95_delta_e2000: {
    plain: '最偏的 5% 画面的色彩偏差，用来看局部色偏。',
    why: '平均值正常但这一项高，通常是个别镜头偏色。',
    action: '先定位偏色镜头，再单独重跑或统一调色后复核。'
  }
}

export function explainRule(ruleId: string): RuleExplanation {
  return RULE_EXPLANATIONS[ruleId] ?? UNKNOWN
}

function joinedNames(rules: SnapshotRule[]): string {
  const names = rules.map((rule) => rule.name || rule.id).filter(Boolean)
  if (names.length === 0) return ''
  const head = names.slice(0, 3).join('、')
  return names.length > 3 ? `${head} 等 ${names.length} 条` : head
}

/**
 * 结论映射（AC1）：fail 优先；全无判定 → 数据不足；有通过但也有缺失 → 需要注意。
 * 计数与规则逐行判定同源，页面不得另行计算。
 */
export function overallVerdict(rules: SnapshotRule[]): VerdictSummary {
  const total = rules.length
  const passed = rules.filter((rule) => rule.verdict === 'pass')
  const failed = rules.filter((rule) => rule.verdict === 'fail')
  const unavailable = rules.filter((rule) => rule.actual === null || rule.verdict === null)
  const counts = {
    pass: passed.length,
    fail: failed.length,
    unavailable: unavailable.length,
    total
  }

  if (total === 0 || passed.length + failed.length === 0) {
    return {
      kind: 'insufficient',
      label: '数据不足',
      plain:
        total === 0
          ? '本页没有拿到门禁规则清单，不能给出通过/未通过结论。'
          : `${total} 条门禁规则都没有实测值，不能给出通过/未通过结论；可先看下方曲线与采样点，正式判定需在 B 轨重跑生成指标。`,
      counts
    }
  }

  if (failed.length > 0) {
    return {
      kind: 'fail',
      label: '未通过',
      plain: `${failed.length} 条规则未达标（${joinedNames(failed)}）；请按下方「建议动作」逐条处理后重跑。`,
      counts
    }
  }

  if (unavailable.length > 0) {
    return {
      kind: 'attention',
      label: '需要注意',
      plain: `${passed.length} 条规则通过，另有 ${unavailable.length} 条暂无实测值；补齐缺失指标或人工抽查后再交付。`,
      counts
    }
  }

  return {
    kind: 'pass',
    label: '通过',
    plain: `${total} 条规则全部达标，可以进入交付。`,
    counts
  }
}
