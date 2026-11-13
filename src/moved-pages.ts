export type NewEntry = {
  to: string
  label: string
  note: string
}

/** 旧深链指向当前仍可用的入口（顺序即页面展示顺序）。 */
export const NEW_ENTRIES: NewEntry[] = [
  { to: '/', label: '视频生产总台', note: 'KPI 看板、生产链路与待办' },
  { to: '/studio', label: '双轨创作工坊', note: '剧本、图片、优化与上传' },
  { to: '/jobs', label: '任务中心', note: '制作任务与队列状态' },
  { to: '/qc', label: 'QC 质量门禁', note: 'SSIM / 噪声 / 判定汇总' },
  { to: '/deliveries', label: '交付成片库', note: '成片、海报与报告' },
  { to: '/agents', label: 'Agent 与提示词库', note: 'Agent、Skill 与提示词' }
]

export type MovedPage = {
  path: string
  oldName: string
  title: string
  reason: string
  primaryTo: string
}

/** 已迁移的旧路由：保留说明页，避免旧书签静默跳首页。 */
export const MOVED_PAGES: Record<string, MovedPage> = {
  '/status': {
    path: '/status',
    oldName: '项目状态',
    title: '项目状态已迁移',
    reason: '项目状态页已并入视频生产总台，实时进度、阻塞与待办都在总台查看。',
    primaryTo: '/'
  },
  '/reports': {
    path: '/reports',
    oldName: '报表与周报',
    title: '报表与周报已迁移',
    reason: '周期汇总已并入视频生产总台，产物报告与评分在交付成片库查看。',
    primaryTo: '/'
  },
  '/issues': {
    path: '/issues',
    oldName: 'Issue 收件箱',
    title: 'Issue 收件箱已迁移',
    reason: '站内 Issue 收件箱已停用，问题跟踪统一到 Gitea；相关任务可在总台与 Agent 库查看。',
    primaryTo: '/'
  },
  '/flow': {
    path: '/flow',
    oldName: '自动编排监看',
    title: '自动编排监看已迁移',
    reason: '自动编排监看已并入双轨创作工坊，任务链路与队列在创作工坊、任务中心查看。',
    primaryTo: '/studio'
  },
  '/pipeline': {
    path: '/pipeline',
    oldName: '渲染工作台与契约',
    title: '渲染工作台与契约已迁移',
    reason: '渲染入口与契约信息已并入双轨创作工坊，随对应任务展示。',
    primaryTo: '/studio'
  }
}

export function movedPageFor(path: string): MovedPage | null {
  return MOVED_PAGES[path] ?? null
}
