import fs from 'node:fs'
import path from 'node:path'

export const PREVIEW_DIRNAME = '.preview-data'

/** 解析真实路径；目标尚不存在时，取最近已存在祖先的真实路径再拼回后缀。 */
export function realish(p) {
  const resolved = path.resolve(p)
  let current = resolved
  const suffix = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    suffix.unshift(path.basename(current))
    current = parent
  }
  try {
    return path.join(fs.realpathSync(current), ...suffix)
  } catch {
    return resolved
  }
}

/** `child` 是否等于 `parent` 或位于其内部（含等于）。 */
export function isWithin(parent, child) {
  const rel = path.relative(realish(parent), realish(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 预览数据守卫：seed 脚本只允许写入 `<cwd>/.preview-data/`。
 *
 * 拒绝（调用方应 `process.exit(2)`）：
 * 1. 输出根目录名不是 `.preview-data`（防止把 ROOT 配错）；
 * 2. 目标不在 `.preview-data/` 内（非预览目录一律拒绝）；
 * 3. 目标等于或位于 `WEB_DATA_ROOT` 内（真实数据根绝不能被 seed 覆盖）。
 */
export function checkPreviewOutput({ target, cwd = process.cwd(), webDataRoot, previewRoot }) {
  const preview = realish(previewRoot ?? path.join(cwd, PREVIEW_DIRNAME))
  const resolvedTarget = realish(target)

  if (path.basename(preview) !== PREVIEW_DIRNAME) {
    return { ok: false, reason: `输出根 ${preview} 不是 ${PREVIEW_DIRNAME}` }
  }
  if (!isWithin(preview, resolvedTarget)) {
    return {
      ok: false,
      reason: `输出目标 ${resolvedTarget} 不在 ${preview} 内（只允许写入 ${PREVIEW_DIRNAME}/）`
    }
  }
  if (webDataRoot) {
    const realRoot = realish(webDataRoot)
    if (isWithin(realRoot, resolvedTarget)) {
      return {
        ok: false,
        reason: `输出目标 ${resolvedTarget} 等于或位于 WEB_DATA_ROOT=${realRoot}，拒绝覆盖真实数据`
      }
    }
  }
  return { ok: true, reason: '' }
}
