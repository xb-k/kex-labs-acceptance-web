# Web-First 验收规范

本仓 Web 验收以**真实浏览器跑通全链路**为准。任何只验后端、只验接口、只验编排器的结论都不算验收通过。

## 1. 入口：浏览器直连 Studio

- 用 Playwright（系统 Chrome）打开 `http://<web>/studio`，从页面交互发起任务。
- 必须走完整链路：**页面操作 → `/api/studio/jobs` → runner/intake → 结果回写 → 页面回显**。
- 禁止用 `curl` 打接口、直接调 orchestrator 或手工写 meta 冒充全链路；这些只能作为造数据/排障的辅助手段，结论仍以浏览器为准。
- 每个用例在页面上有唯一可观测的落点（列表新条目 / 详情 / 媒体可见）。

## 2. 浏览器硬断言

- `console.error`、`pageerror`、任何 `/api/*` 的 4xx/5xx 响应 = **FAIL**（允许清单需在用例中写明理由）。
- 列表：DOM 条目数 = 后端 `count`；`job_id` / `brief_id` 唯一无重复；图片按内容去重（同一 hash 只出现一次）。
- 翻页 / 刷新后数据不丢、不重复、顺序稳定；切换 tab 回来仍是同一批 id。
- 媒体元素必须真实可播/可看，`naturalWidth/Height > 0`，不能靠占位图。

## 3. 跨端一致性

- 页面上展示的 `job_id` 必须能在后端 `state` / `clip_report` / `summary` 中对上，字段值一致。
- UI 传入的参数（mode / prompt / keyframe / 时长 / 比例）必须原样出现在后端落盘记录里，不允许 UI 与后端口径漂移。
- 媒体请求返回 200（或 Range 请求 206），`Content-Type` 与后缀匹配；404/403 视为 FAIL。

## 4. 证据

- 证据目录：`acceptance/issue-<n>/evidence-web/<run>/`。
- 至少包含：Playwright 报告/日志、失败截图或录屏、关键接口响应、后端落盘文件摘录（state / clip_report / summary）、run 命令与时间戳。
- 禁止 mock、禁止手工改数据后截图冒充；环境不可达时如实标注「未验证」，不得写 PASS。
