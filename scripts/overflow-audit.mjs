#!/usr/bin/env node
/**
 * 全站真实数据溢出审计（ui-overflow-audit）
 *
 * 用法：
 *   NODE_PATH=~/.config/opencode/tool/web-tester/node_modules node scripts/overflow-audit.mjs \
 *     --base http://100.123.73.123:8088 --out ../issue-19/evidence-web/ui-overflow --tag before
 *
 * 每页 × 1440x900 / 1024x768 / 390x844：
 *  1. document.scrollingElement.scrollWidth > innerWidth（整页横向滚动）
 *  2. 元素 rect.right > innerWidth + 1（越界；overflow-x 容器内部的不算越界，单独计数）
 *  3. scrollWidth > clientWidth + 1 且 overflow-x 不是 auto/scroll 的文本容器（截断缺失）
 *  4. 长 ID / URL / 路径 / 长串撑破卡片（随 2/3 一起记录 selector + 文本摘要）
 *  5. console error / 失败请求
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// playwright-core 不在本仓 devDependencies（审计脚本不想为它加依赖），
// 优先本地解析，找不到就退回 web-tester 技能自带的依赖。
const loadPlaywright = async () => {
  try {
    return await import('playwright-core')
  } catch {
    const fallback = path.join(homedir(), '.config/opencode/tool/web-tester/node_modules/playwright-core/index.js')
    return await import(fallback)
  }
}
const pw = await loadPlaywright()
const chromium = pw.chromium ?? pw.default?.chromium

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? dflt : args[i + 1]
}

const BASE = arg('base', 'http://100.123.73.123:8088')
const OUT = path.resolve(arg('out', '../issue-19/evidence-web/ui-overflow'))
const TAG = arg('tag', 'before')
const SHOTS = !args.includes('--no-shots')
const ONLY = arg('only', '')

const PAGES = [
  ['home', '/'],
  ['studio', '/studio'],
  ['jobs', '/jobs'],
  ['qc', '/qc'],
  ['deliveries', '/deliveries'],
  ['agents', '/agents'],
  ['issues', '/issues'],
  ['job', '/job/s0']
].filter(([slug]) => !ONLY || ONLY.split(',').includes(slug))

const VIEWPORTS = [
  [1440, 900],
  [1024, 768],
  [390, 844]
]

const collect = () => {
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className : ''
    const clsShort = cls.split(/\s+/).filter(Boolean).slice(0, 6).join('.')
    let sel = el.tagName.toLowerCase()
    if (el.id) sel += `#${el.id}`
    if (clsShort) sel += `.${clsShort}`
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    return { selector: sel, text }
  }
  const inScroller = (el) => {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const ox = getComputedStyle(node).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    return false
  }

  const vw = window.innerWidth
  const docEl = document.scrollingElement || document.documentElement
  const result = {
    viewport: { width: vw, height: window.innerHeight },
    docOverflow: docEl.scrollWidth - vw,
    outOfBounds: [],
    insideScrollers: [],
    clippedText: []
  }

  for (const el of document.body.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    const overflowRight = Math.round(rect.right - vw)
    if (rect.right > vw + 1) {
      const entry = { ...describe(el), right: Math.round(rect.right), over: overflowRight }
      if (inScroller(el)) {
        entry.note = 'inside-overflow-x-container'
        result.insideScrollers.push(entry)
      } else {
        result.outOfBounds.push(entry)
      }
      continue
    }
    const ox = style.overflowX
    // 纯装饰 / 屏幕阅读器专用元素不算「截断缺失」：无文本、svg 图形、sr-only、状态光点
    const isDecoration =
      el.closest('svg') !== null ||
      el.classList.contains('sr-only') ||
      (el.textContent || '').trim() === '' ||
      el.className.toString().includes('live-beacon')
    if (
      !isDecoration &&
      el.scrollWidth > el.clientWidth + 4 &&
      ox !== 'auto' &&
      ox !== 'scroll' &&
      ox !== 'hidden'
    ) {
      result.clippedText.push({
        ...describe(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        over: el.scrollWidth - el.clientWidth
      })
    }
  }
  // 只留最外层：父级已记录的子级重复信息去掉，报告更好读
  const dedupe = (list) => {
    const seen = new Set()
    return list.filter((item) => {
      if (seen.has(item.selector)) return false
      seen.add(item.selector)
      return true
    })
  }
  result.outOfBounds = dedupe(result.outOfBounds).slice(0, 60)
  result.insideScrollers = dedupe(result.insideScrollers).slice(0, 40)
  result.clippedText = dedupe(result.clippedText).slice(0, 60)
  return result
}

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const summary = []

for (const [slug, route] of PAGES) {
  for (const [width, height] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const consoleErrors = []
    const failedRequests = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
    })
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 300)}`))
    page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`.slice(0, 300)))
    page.on('response', (res) => {
      if (res.status() >= 400 && res.url().includes('/api/')) failedRequests.push(`${res.status()} ${res.url()}`.slice(0, 300))
    })

    let report = { page: slug, route, width, height, error: null }
    try {
      await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45000 })
      await page.waitForTimeout(1200)
      const metrics = await page.evaluate(collect)
      report = { ...report, ...metrics, consoleErrors, failedRequests }
      if (SHOTS) {
        await page.screenshot({ path: path.join(OUT, `${slug}-${width}-${TAG}.png`), fullPage: false })
      }
    } catch (err) {
      report.error = String(err).slice(0, 500)
      report.consoleErrors = consoleErrors
      report.failedRequests = failedRequests
    }
    await writeFile(path.join(OUT, `${slug}-${width}-${TAG}.json`), JSON.stringify(report, null, 2))
    summary.push({
      page: slug,
      width,
      docOverflow: report.docOverflow ?? null,
      out: report.outOfBounds?.length ?? null,
      clipped: report.clippedText?.length ?? null,
      console: consoleErrors.length,
      failed: failedRequests.length,
      error: report.error
    })
    await context.close()
  }
}

await browser.close()
await writeFile(path.join(OUT, `summary-${TAG}.json`), JSON.stringify(summary, null, 2))
const pad = (v) => String(v).padStart(4)
console.log('page        width docOverflow  out clipped console failed')
for (const r of summary) {
  console.log(`${r.page.padEnd(12)}${pad(r.width)} ${pad(r.docOverflow)} ${pad(r.out)} ${pad(r.clipped)} ${pad(r.console)} ${pad(r.failed)}${r.error ? '  ERROR: ' + r.error.slice(0, 80) : ''}`)
}
