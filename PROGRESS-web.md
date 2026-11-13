# PROGRESS · T-WEB-001

- 2026-11-10 16:20 读工单 + 真实数据源（summary/report/metrics/gate），确认 S1 判定 = FAIL（B2 噪声 +23.8% > +15%），S0 = PASS（有条件）。
- 2026-11-10 16:24 建目录：src/pages、src/components、server。开始搭 Vite + React18 + TS + Tailwind。
- 2026-11-10 16:40 完成 server/api.ts（扫描/API/Range）、DESIGN.md、全部页面与组件、README。待 npm install + 类型检查 + 起服务验证。
- 2026-11-10 16:50 接力：typecheck EXIT 0、build PASS；旧 dev server 占 5173（仅绑 ::1），用 localhost 验证 / /api/jobs / /api/metrics/s1 /api/qc/s1 均 200，Range 206；metrics 0.9264 与 summary aggregate 一致。下一步：新增 /api/status + 项目状态页 + 截图。
- 2026-11-10 17:05 收尾棒：build PASS（tsc 0 错误，vite 45 modules / 802ms）。品牌统一为 Kex Labs（index.html / Shell logo / footer / README / DESIGN）；README 补 /api/status 契约、数据源与新增 job 流程。
- 2026-11-10 17:05 对比度：新增 token `blueInk #0062C4`（浅蓝底）与 `subtextAlt #6B6B70`（灰底），替换全站 7 处蓝字 + 5 处灰底次文本。下一步：4 宽度截图 + detect。
- 2026-11-10 17:20 截图：1440/1280/1024/390 × 4 页共 16 张写入 `screenshots/<宽度>/`；四宽度 scrollWidth==clientWidth（390 实测 390/390）。品牌与颜色计算值实测通过（Kex Labs、rgb(0,98,196)、rgb(107,107,112)）。
- 2026-11-10 17:22 `impeccable detect`：文件扫描 18 文件 0 findings；URL 扫描 / 与 /status（1280、/ 390）均 `[]`、EXIT 0。补 `<link rel="icon" href="data:,">` 消除唯一 favicon 404；build 复跑 PASS。
- 2026-11-10 17:10 部署收尾棒（T-WEB-002c）：只读+验收，未改架构。studio `com.kexlabs.web` running（pid 73287），`launchctl kickstart -k` 后 3s 新 pid 74494、`/` 与 `/api/jobs` 均 200；`com.kexlabs.video` 未动。
- 2026-11-10 17:12 远端 8 项 curl 全绿：`/`=200 text/html、`/api/jobs` s0=CONDITIONAL(1/7)+s1=FAIL(6/7) 且 hasQc=true、`/api/status` exists=true/milestones=4、qc+metrics 200、`/media/out/s{1,0}` Range 206（61.8MB/16.2MB）、`/job/s1` fallback 200、首页无 mock 字样。产物+数据 12 个 sha256 与本地逐字节一致。
- 2026-11-10 17:15 浏览器（本机 Chrome/playwright-core，390×844）：首页 2 卡、状态页 S0/S1、console error 0、pageerror 0、三页 scrollWidth==clientWidth、视频自然加载 readyState 3/1（约 30–45s，moov 在尾部导致）。截图 3 张存 `screenshots/remote-8088/`。
- 2026-11-10 17:16 Docker 静态校验：本机 daemon DOWN 无法 build；`docker compose config` exit=0，端口/只读挂载/healthcheck 解析正确，镜像未实构、NAS 未部署。文档：`issue-19/web-deploy.md`（拓扑/证据/sha/回滚/未验证）、README 补「部署」节。

# PROGRESS · T-DB-003（DB 层接入 · 接力第 2 轮）

- 2026-11-10 17:50 `server/db.ts` 支持 `PG*` 回退（`DATABASE_URL` 优先；四项齐全才启用）；`npm run typecheck` EXIT 0，`npm run build:server` 出 `serve.mjs` 131.4kb / `sync.mjs` 100.5kb。
- 2026-11-10 17:51 只传运行件到 NAS `acceptance-web/`（`server/{serve,sync}.mjs` + `db/schema.sql`，sha256 与本机逐一相同）；**未传 dist、未碰 studio:8088、未改 `web/src/**`**。数据从 studio 经 tar 管道直传（165M），`IMG_3189.MOV`、`b-track-s0/summary_v2.json`、`b-track-s1/{summary.json,clip_60fps_s1.mp4}` sha256 与本地一致。
- 2026-11-10 17:52 `sync.mjs` 连跑两遍：run1 `snapshots.tasks_plan/project_status=true`、run2 均 `false`（幂等，不新增快照），两次 EXIT 0，`tasks=33 milestones=4 jobs=2 criteria=14 metrics=34 artifacts=13`。
- 2026-11-10 17:53 DB serve 真验（容器 `acceptance-web-dbtest`，127.0.0.1:18088）：日志 `dataSource=postgres`；`/api/plan` → `{source:"postgres",tasks:33}`，`/api/{overview,jobs,deliveries,tasks/T-WEB-004,status}` 全 200 且 `meta.source=postgres`。计数 `33|2|13|2|2`（tasks/jobs/artifacts/snapshots/sync_runs）。验完已 `docker stop`。
- 2026-11-10 17:54 PATCH 真验：files 模式（8089，`WEB_WRITE_TOKEN`）`PATCH /api/tasks/T-WEB-004 {progress:100}` → 200 + `tasks.json` 原子更新（mtime 17:46:02→17:53:19、无 `.tmp-*` 残留、错 token → 401），验后还原 sha256 `1c08a336…`；DB 模式 `PATCH` → 200 `meta.source=postgres` + `acceptance.events` 新增 1 条 `task.update|T-WEB-004`。测试容器/进程已全部停掉（8089 上的旧 `serve.mjs` 一并清理）。
- 未验证：NAS 上 8088 正式端口部署（本单只做 DB 层，UI 部署在另一 agent）；studio 在线探测在 NAS 容器内为离线（容器无 `COMFYUI_URL`，预期）。

# PROGRESS · T-WEB-005（V2 骨架 + 工作台总览，第 1 轮）

- 2026-11-10 17:40 读工单 + 真实接口（/api/system /api/overview /api/deliveries 已存在于 server）；确认只改 web/src/** + index.html。
- 2026-11-10 17:45 重写 Shell：236px 侧栏（品牌/8 导航/Mac Studio 卡）+ 390 抽屉（Esc/焦点陷阱/aria）；新增 useSystem（/api/system→/api/health 回退）。
- 2026-11-10 17:50 新增 DashboardPage + TaskFlowBoard（/api/plan 全量 34 条 4 列）+ 5 个占位页；路由 `/`→总览、`/jobs`→任务列表，旧路由保留；tsc EXIT 0、vite build PASS。
- 2026-11-10 17:52 本机 Playwright：9 路由 ×1440/390，scrollWidth==clientWidth、console/pageerror 0、视频 readyState 4；抽屉键盘/焦点通过；对比度 AA 全过。
- 2026-11-10 17:55 部署 studio:8088（rsync dist + kickstart），8 路由 curl 200；远端旧 serve.mjs 无新接口 → UI 降级「接口待接入」，资源 404 探针 4 条、JS 异常 0（T-DB-003 部署后消失）。
- 证据：`issue-19/web-v2-shell.md`；截图 `web/screenshots/v2/`（含 remote/）。

# PROGRESS · T-WEB-013（构建 + 部署 + r2 截图验收）

- 2026-11-10 18:17 首跑 `npm run build` EXIT 2：`Placeholders.tsx` 4 处仍用旧 `sys.studio.online/latencyMs`，与 18:09 归一化后的 `SystemSnapshot` 不匹配。只改取值（`sys.online`/`sys.latencyMs`，null 显示「无数据」），不动逻辑与布局。
- 2026-11-10 18:18 二跑构建 EXIT 0（52 modules，js 255.95 kB / css 35.60 kB）。本机 preview 9 路由 × 1440/390 全 200、无横向溢出、console error 0。
- 2026-11-10 18:18 部署 studio:8088：备份 `serve.mjs.bak-20261110T181850`，rsync dist + serve.mjs（sha `d948073c…`，与远端 serve-8092 相同，确认与 api.ts 同步）；kickstart PID 88381 → 91918。
- 2026-11-10 18:19 远端 curl：system 200（online、latency 22ms、vram free 32.4GiB）、plan 200 tasks=34、deliveries 200 ×2、jobs 200 ×2、qc/summary 200；cover 400/200(job=s1)、explain 405/400 → 路由上线。
- 2026-11-10 18:22 r2 截图 18 张（9 路由 ×1440/390，先滚动触发懒加载）存 `screenshots/v2/r2/`；全部 scrollWidth==clientWidth、console err 0、骨架清零，关键区块真实数据可见。
- 2026-11-10 18:23 交互实测：看板待排队 6→10、已完成 6→12→19（按钮随剩余归零消失）；懒加载骨架 4→0。Apple 质感（毛玻璃/字重/浅灰底白卡）在构建 CSS 与截图中生效。
- 证据：`issue-19/web-r2-build.md` + `issue-19/evidence-web/tweb013/`。

# PROGRESS · T-WEB-014（repairs 契约 + 封面去 PIP + AI explain 真机验收）

- 2026-11-10 18:41 部署 studio:8088（备份 `serve.mjs.bak-20261110T184148`，rsync serve/sync + s0 ai-repair 数据）；kickstart PID 91918 → 96481。
- 2026-11-10 18:42 `/api/repairs?job=s0` count=1/available=true、output `Range 0-1023` → 206、compare 3×200；`/api/jobs/s0` repairs=1；`/api/deliveries` s0 `repair.repaired=true`；`/api/system` 200、`/api/plan` 200 tasks=34。
- 2026-11-10 18:43 `/api/explain`：GET 405；POST s1 200（items 7/issues/suggestions/disclaimer）；force 重算 7420ms；再 POST cached=true 103ms。
- 2026-11-10 18:44 封面：实测 23% 裁顶切头发且残留小窗底条（`crop23-broken.jpg`）→ 改为 PIP 矩形品牌色块（`PIP_MASK 0.625/0.008/0.345/0.26` + 金边，不裁画面）；studio 重生成 16x9/9x16（sha `31acdf9e…` / `dfe73ef8…`），人工看图通过，已回写本地 cover_*.jpg 与 cover16/9-v2.jpg。
- 未验证：`/api/tasks/T-VID-084`（tasks.json 无此 id → 404，验收口径问题）、NAS PG sync（5432 未发布，studio 直连 refused）、本机 :8099 遗留进程（kill 权限被策略禁止）。
- 证据：`issue-19/web-cover-explain.md`、`issue-19/evidence-web/tweb014/`。

# PROGRESS · T-WEB-015a（看板限高 + 克制的色彩语义）

- 2026-11-10 18:49 P0 看板限高：4 列 `xl:h-[min(72vh,760px)]`，列内滚动 + sticky 列头；平板 2×2 每列 `max-h-[55vh]`；手机单列每列 `max-h-[60vh]`。加载更多留在列内底部。1440 body 1719→**1487**，加载更多后仍 1487；390 `scrollWidth==clientWidth==390`。
- 2026-11-10 18:51 P1 视觉：状态色四色贯穿（tint 列头/3px 色条/进度条/卡左缘）、KPI accent 条、标题 32/600、区块 3px 色条、顶部 120px 冷蓝渐变、logo 蓝紫渐变、选中项淡蓝底+蓝条、在线绿字；甘特完成改低饱和绿。`DESIGN.md` 同步。
- 2026-11-10 18:56 build EXIT 0；本机 preview 18/18 200、无溢出、console 0；部署 studio:8088 PID 96481→99050；远端 18/18 200、console 0；截图 `screenshots/v2/r3/` 18 张。detect 63→32（剩余均为规格既定结构），低对比/过小字清零。
- 证据：`issue-19/web-v2-visual.md`、`issue-19/evidence-web/tweb015a/`。

# PROGRESS · T-WEB-015a2（看板细节打磨）

- 2026-11-10 19:05 标题层级：看板标题 15→18/600；来源 11px 不变；「任务计划」从文字链改白底浅边 8px/12px 次级胶囊。
- 2026-11-10 19:05 任务卡：圆角 20→10、内边距 12、`shadow-soft`、行距 1.45；列容器仍 20。轨别 A/B/双轨统一中性浅底（`black/3%` + `subtextAlt`，4.94:1）。
- 2026-11-10 19:05 阻塞：琥珀微底胶囊 `#FBF1E4/#8A4B00/#F0D9BC`（6.09:1）+ 新 SVG `TriangleAlert`；无原因回退「阻塞（原因未说明）」；非阻塞仍显示预计完成。进度 3px 细线，百分比 11px 次色靠右，完成态不再强调。
- 2026-11-10 19:06 build EXIT 0；本机 preview 1440/390 console 0、无溢出、列内滚动+sticky、加载更多 body 高度不变（1496→1496 / 3963→3963）；部署 studio:8088 PID 406，`/`、`/api/system`、`/api/plan` 200；截图 `screenshots/v2/r4/`（1440/390 首页 + 1440 看板特写），r3 保留。
- 证据：`issue-19/web-v2-board-polish.md`、`issue-19/evidence-web/tweb015a2/`。

# PROGRESS · T-WEB-015b（/api/issues 后端 + 元数据补齐 + 部署）

- 2026-11-10 19:10 `server/api.ts` 新增 `WEB_ISSUE_ROOT`/`WEB_ISSUE_WRITE`/`WEB_ISSUE_TOKEN` 与 `/api/issues`：GET/HEAD 扫 `issue-N/`（issue.json 合法字段 > README 首行 > 目录名，created_at 回退目录 birthtime，坏 JSON 忽略），POST 校验 + 原子建目录（EEXIST 重试 5 次）+ 临时文件 rename 落 `issue.json`/`README.md`，写失败清理目录；token 401、写关闭 403、路径越界 403。
- 2026-11-10 19:10 15 个现有 issue 目录补齐最小 `issue.json`（`source:"backfill"`、title=`issue-N`、created_at=目录 birthtime，不写 owner/rail/priority/description），清单见证据 `backfill-map.tsv`。
- 2026-11-10 19:12 typecheck EXIT 0；`npm run build:server` EXIT 0；本机真实 HTTP 23/23 通过：GET 200 count=15 latest=issue-10、POST 201 number=31（目录/issue.json/README.md 落盘）、空 title 400、非法 rail 400、token 无头 401/带头 201、`WEB_ISSUE_WRITE=0` POST 403 + GET 200、PUT 405、HEAD 200。
- 2026-11-10 19:14 部署 studio：备份 `serve.mjs.bak-tweb015b`（旧 sha 39546e0…），rsync serve.mjs（sha f35302b…）+ 15 个 issue.json，kickstart PID 406→3138；远端 `/api/issues` 200 count=15 latest=issue-10、`/`、`/api/jobs`、`/api/plan`、`/api/system`、`/api/repairs` 均 200。
- 未验证：写入失败清理（仅静态审查）；studio 未配置 `WEB_ISSUE_TOKEN`/`WEB_ISSUE_WRITE`，远端只做 GET 只读验证。
- 证据：`issue-19/evidence-web/tweb015b/`（run.out、GET/POST/401/403/400 JSON、远端 JSON、deploy.txt）。

# PROGRESS · T-WEB-015c（Issues 列表页 + 侧栏 Issue 卡 + 新建弹窗 · 复验与部署）

- 2026-11-10 21:30 接力复验（relay 2/3）：确认 dist `19:41:13` 晚于源码 `19:40:48`（asset `index-e4Ug6I-w.js` / `index-BxFker-i.css`），旧证据 19:21 已过期；清理残留 4173/8092/serve.mjs 共 4 个进程；临时根 `/tmp/tweb015c-r2` 仅 15 个 `issue.json`（60K）。
- 2026-11-10 21:33 本机 8093 重跑 `local-e2e-r2.mjs`（1440+390+9 路由烟测）全绿：列表 15、折叠 localStorage 持久、点卡进 `/issues`、空标题 0 请求、创建 201→16 行+高亮+`aria-live`+3.3s 消退、Esc/背景关闭+焦点回归、9 路由 200 标题非空、`scrollWidth==clientWidth==1440/390`、console/pageerror 全 0；受控创建目录已删除，count 回 15；截图 r5 五张 1440 覆盖 + 新增 `390-issues.png`/`390-dialog.png`。
- 2026-11-10 21:34 rsync `web/dist` → studio `~/kex/acceptance-ui/dist`（远端 asset sha256 与本机一致），kickstart `com.kexlabs.web` rc 0；`/`、`/issues`、`/api/issues` 200、count=15。
- 2026-11-10 21:35 远端 Playwright 1440/390 全绿（15 行、两卡可见、无溢出、console 0），UI 受控写入 `issue-31` 201+高亮+`aria-live`，随后 `mv` 到 `/tmp/tweb015c-remote-created-31`，count 回 15。
- 偏差：zsh 不对 `$SSH` 变量分词，备份 `dist.bak-tweb015c` 未执行 → 远端缺 015b dist 回滚点（serve.mjs 回滚点仍在）。
- 证据：`issue-19/web-issues-ui.md`、`issue-19/evidence-web/tweb015c/`（CHECKPOINT、local-e2e-r2.mjs/json、remote-verify.mjs/json、deploy.txt、sha256.txt）。

# PROGRESS · T-WEB-015c2（卡片等高 + 全站动效 + 左下角 Dock）

- 2026-11-10 21:47–22:05 relay 1/2：`typecheck` 静默、`build` EXIT 0 → `index-Cjsyg3xP.js`/`index-DB4hyRxr.css`；完成 C（`SideDock` 两 icon + popover，Esc `stopImmediatePropagation` 修 390 抽屉连关）、A（5 处 `data-equal-grid`、双栏 `items-stretch`、卡 `h-full` + `mt-auto`）、B（page-enter/stagger/popover/dialog/highlight/chart/gantt）；本机 8094 实测等高 delta 0、9 路由 console 0、截图 8 张 → `web/screenshots/v2/r6/`、`height-audit.json`。留录屏/部署/文档。
- 2026-11-10 22:03–22:04 relay 2（续）：重建 dist `index-Cf6qNijV.js`/`index-UfWvAm0w.css`，Playwright 截 42 帧（1280×800）+ `motion-assertions.json` 全绿；随后会话在 **88 步被硬掐**，未编码/未部署/未写文档。
- 2026-11-10 22:06 relay 3：`ffmpeg` 编 `web/screenshots/v2/r6/motion.webm`（VP9 1280×800 5fps 8.4s 247,064B）；补 `web/DESIGN.md` 两节（等高约定、动效 token 表）、`issue-19/web-card-motion.md`。
- 2026-11-10 22:07 部署 studio：`dist.bak-tweb015c2` 备份（旧 `index-e4Ug6I-w.js`）→ `rsync -a --delete` → `kickstart` PID **35484**；远端 `/`、`/issues`、`/api/issues` 200，count=15 latest=issue-10，index.html 引用 `index-Cf6qNijV.js`，asset sha 与本机一致。
- 2026-11-10 22:07 远端只读验证（`MODE=remote BASE=http://100.92.106.101:8088`）：默认 2 icon / 旧大卡 0 / popover「共 15 条 · issue-10」点外关闭 / `/issues` 15 行 / 390 icon 2 / 无横向溢出 / console+pageerror 0；`/job/s0/qc` chart-draw 0.35s、`/status` gantt 34 条 0.3s、reduced 1e-05s；远端 3 张截图。**未写入任何数据**。
- asset：`index-Cf6qNijV.js` sha256 `d13ef6039da52f3d59236a2bc8c07aa94e2a180e352491ccc51b7928e16ad1f7`；`index-UfWvAm0w.css` `53286492f95b37b65ad3cac2816272f81c5b8aef3c5c9eb60f5129602694a483`；`motion.webm` `349c76e253f49dc58570cd38c6022e389391933e540bb5e514161fbfc07788e2`。
- 偏差/未验证：Safari/Firefox、真触屏、远端逐帧录制未验；`/qc` 读图路由在验证脚本里由 `/qc/<id>` 修正为 `/job/<id>/qc`（脚本内注释路径，非产品代码）。
- 证据：`issue-19/evidence-web/tweb015c2/`（CHECKPOINT-relay1、CHECKPOINT-relay3、height-audit、motion-assertions、remote-verify、deploy.txt、sha256.txt）。

# PROGRESS · T-WEB-015d1（真实数据端点：flow / contract / weekly / media-kex）

- 2026-11-10 22:12 新增 `web/server/insights.ts`（`flowData`/`contractData`/`weeklyReport`/`resolveKexMedia`，自成一体 + 5s mtime 缓存 + realpath 越界拦截；缺失一律 `available:false`/`null`，零假数据）；`server/api.ts` 导出 `deliveriesData`、加 4 条路由、`MEDIA_TYPES` 补 `.jpeg/.webp`。
- 22:13 `typecheck` EXIT 0；`build:server` EXIT 0（serve.mjs 189.8kb）。
- 22:14 studio-ts **只读** rsync 真实 fixture → `/tmp/kex-fixture`（state/decisions/workflows/docs/policy/reports + jobs/b17_syn_phase2 的 frames/reports，排除 mp4）+ `/tmp/kex-logs`（worker log 4.8KB）。
- 22:15 真 HTTP（本机 8095，`WEB_DATA_ROOT=<repo> KEX_REPO_ROOT=/tmp/kex-fixture KEX_LOG_DIR=/tmp/kex-logs`）：
  - `/api/flow` 200 available:true；jobs=123；latest=`issue9_demo_a2`；stage=E；**`stages.F.status=failed`**；shots=12；decisions=1 行；artifacts=15（全部 exists:false，路径已删，如实）；logs.worker=27 行；lock_events=50；warnings=0。
  - `?job=b-track-s1` 200 `job:null`+`no_orchestrator_state`；`?job=nope` 404；`?job=b17_syn_phase2` reports render/assemble/interpolate 经 jobs 目录回退全读到（render.memory 存在）。
  - `/api/contract` 200：gate 5 条（A1/A2/B1/B2/B3）均含 source_line；thresholds 7 条；workflow 768/512/49/30/3/6/1/seed0/euler/normal/ckpt 正确，cutoff null；queue.inbox=[]；recent 非空（issue9_demo_a2 + probe）。
  - `/api/reports/weekly` 200：total=34，done/running/pending/blocked=20/1/10/3，deliveries 2/repaired 1，deviations=3，risks=6，burndown=null + note「无历史快照（DB 未启用）」。
  - `/media/kex?path=jobs/b17_syn_phase2/frames/shot_0001_01.png` → 200 `image/png` 324637B，Range 0-99 → 206；`../`→403、`.json`→400、`state/`→403、缺失→404。
  - 空目录启动（8096，无 KEX_REPO_ROOT）→ flow/contract/weekly 均 200 `available:false`、media 404，无 500。既有端点（system/overview/plan/deliveries/jobs/status/issues/qc-summary/artifact）回归全 200。
- 未验证：studio 远端未起本端点（仅本机 fixture）；DB burndown/velocity（无 DATABASE_URL，走 files 分支）。
- 证据：`issue-19/evidence-web/tweb015d1/`（flow/contract/weekly/flow-b17 原始 JSON + headers、empty-*、fixture-manifest、typecheck/build-server 日志、CHECKPOINT、sha256）。

# PROGRESS · T-WEB-015d2a（/flow + /pipeline 真数据页）

- 22:31 验证完成：`types.ts`（Flow*/Contract*）+ `api.ts` useLiveJson（保留旧数据、visibility 暂停）+ `DataTable`（桌面表格 / 390 卡片）+ `FlowPage`、`PipelinePage`，路由替换占位页；`typecheck`/`build` EXIT 0（58 modules，js 311.5kB / css 45.5kB）。
- 验证：`tweb015d2a/verify.json` **51/51** 全过（含 6.2s 内 /api/flow ≥2 次、隐藏暂停、恢复补一次）；`ui-vs-api.json` 页面值 == API、diffs=[]；8097 + fixture 真数据 200。
- 证据：`issue-19/evidence-web/tweb015d2a/{verify.json,ui-vs-api.json,sha256.json,CHECKPOINT.md}`、`web/screenshots/v2/r7/1440-{flow,pipeline}.png`。
- 未验证：Safari/Firefox、真触屏。

# PROGRESS · T-WEB-015d2b（/qc + /deliveries 真数据页）

- 22:40 验证完成：`QcPage`（受检数/PASS-FAIL-待判/平均 SSIM/噪声/全量表 + CSV）、`DeliveriesPage`（2 成片、封面回退、AI 修复记录、下载），390 复用 DataTable 卡片布局；`typecheck`/`build` EXIT 0。
- 验证：`tweb015d2b/verify.json` **66/66** 全过；`console-overflow.json` 四视口 console/pageerror/资源失败均 0、无横向溢出；print media 计算样式通过（table 101px/2 行）。
- 数据：`qc-summary.csv` 表头与 UI 列一致；`deliveries.json` 2 条、`repairs-s0.json` 1 条修复记录。
- 证据：`issue-19/evidence-web/tweb015d2b/{verify.json,verify.out,console-overflow.json,ui-vs-api.json,1440-*.png,390-*.png}`、`r7/1440-{qc,deliveries}.png`。
- 未验证：真实打印纸张输出。

# PROGRESS · T-WEB-015d2c（/reports 真数据页 + studio 部署 + 五页远端验收）

- 22:44 构建：`ReportsPage`（KPI 34/20/1/10/3、owner/rail 分布、偏差/风险、里程碑、燃尽空态、CSV/打印）；`typecheck`/`build` EXIT 0 → `index-BgsymiNI.js`(9d9a9530…)/`index-5tyzx-9z.css`；`build:server` → `serve.mjs f348be88…`。
- 22:44–22:55 部署 studio-ts：备份 dist/serve/plist（`.bak-tweb015d2c`）→ rsync dist + serve → kickstart；**PID 43178**、state running、本机/远端 sha 一致、`/api/contract` live thresholds=7。
- 22:55 远端验收：`remote-verify.json` **pass:true / failures:[] / checks=53**（1440 六页 + 390 flow/reports，console 0、无溢出）。
- 唯一失败项 `1440 /pipeline 阈值 7`：API=7、UI=7，根因为断言写死 + 数据未到位竞态 → 改为「UI 行数 == API `thresholds.items.length`」并等提示文案含「N 条」；**未改页面、未重部署**；live 值 7 落 `contract-thresholds.json`。
- relay：本棒 2/2；上一棒 1/2 撞 **88 步硬掐**（部署与五页远端验收已完成，遗留阈值断言 + 部署证据/文档回填）。
- 证据：`issue-19/evidence-web/tweb015d2c/{remote-verify.json,contract-thresholds.json,deploy.txt,sha256.txt,CHECKPOINT-relay2.md}`、`r7/remote-*.png`、`issue-19/web-v2-final.md`。
- 未验证：Safari/Firefox、真触屏、真实打印纸张、DB 燃尽数据（未启用）。

# PROGRESS · T-WEB-016a（016b 部署准备：反代 + compose 变量）

- 22:52–22:58 改动：`server/serve.ts` 加 `UPSTREAM_URL` 反代（全请求流式转发、去 hop-by-hop、`host`/`x-forwarded-*`、30s 仅建连+首包、502/504 `upstream unavailable` + 单行日志、启动日志 `upstream=…`；不设时保持本地行为）；`docker-compose.yml` 增 `KEX_REPO_ROOT`/`KEX_LOG_DIR`、`/data` 改 rw、kex 仓与日志只读；README 补反代/回滚/NAS `$BASE`/变量表/rw 偏差。
- 构建：`typecheck` / `build` / `build:server` **EXIT 0**（`serve.mjs` sha256 `a1ea3491…`）。
- 真跑（本机 8098 上游 + 8099 代理 + 8096 死上游）：`GET /` 200、`/api/issues` 200 count=15、`/api/jobs` 200、`/assets/*` 200 text/javascript、`Range 0-99` → 206 `content-range: bytes 0-99/636`、`HEAD /` 200、`POST /api/issues` 201 且上游落盘 issue-16（直连 count=16）、`PATCH` 无 token 401（方法转发）、死上游 502 `upstream unavailable`；`docker compose config` EXIT 0（/data rw、/kex-repo+/logs ro）。
- 说明：Range 走 `/media/artifact`（本地静态层不支持 Range，`/media/*` 才支持）；8097 被既有进程占用，改用 8096，未动其他进程；三服务已停、`lsof` 复核无监听。
- 证据：`issue-19/evidence-web/tweb016a/{verify.json,build.log,build-server.log,compose-config.yml,stop.txt,CHECKPOINT.md}` + curl 原始头/体。
- 未验证：NAS 实部署/容器实构（016b）、真实长连接与大文件、TLS、studio 实际切反代。

# PROGRESS · T-WEB-016b1（NAS 构建 + 启动容器）

- 23:02–23:06 勘察/送源码：`ugnas`（ProxyJump `studio-ts`）Docker 29.9.2 / Compose v5.7.0，8088 空；tar 管道 → `$BASE/web-src`（排除 node_modules/dist/screenshots/server/*.mjs）。
- 23:04 `.env`（DATA/REPO/LOG）→ `docker compose config` EXIT 0（/data rw、/kex-repo+/logs ro）。
- 23:05 构建：BuildKit 挂 `fatal error: removed GODEBUG "tlskyber"`（RUN npm ci, exit 2）→ `DOCKER_BUILDKIT=0` 重试**成功**。镜像 `sha256:458972d0c779…`（168,831,402 B）；首次部署无旧镜像可打 `prev`。
- 23:05 起容器：无旧容器；`up -d --no-build --wait` → `014cc0f07211` healthy，`0.0.0.0:8088->8088`，日志 `dataSource=files upstream=local`。
- 真 HTTP：health 200（comfyui ok=false 预期）、plan 200 `meta.source=files`、issues **count=1**、deliveries 2、qc/summary jobs=2/thresholds=4、weekly tasks 34/19 done；写测试 POST **201**（`issue-20`，writable=true）→ 移出 /data → count 复原 1；`/media/original` Range **206**、`/assets/*` 200、越界 **403**。
- 双入口：tailscale `100.123.73.123:8088` **200**、LAN `192.168.3.14:8088` **200**。
- 偏差：NAS `kex-labs-video` 是任务产出根（无顶层 `state/workflows/docs/plan/policy`）→ `/api/flow` `jobs=0 reason=no_state_files`、`/api/contract` 空；issues 快照仅 `issue-19`（故新号 issue-20）；`/media/kex` 404（无顶层 `jobs/`）。补齐需仓快照同步（待拍板）。
- 证据：`issue-19/evidence-web/tweb016b1/`（precheck/compose-config/build×2/up/container-inspect/api-*/media-assets/write-test/dual-entry/CHECKPOINT）、`issue-19/nas-web-deploy.md`。
- 未验证：长跑稳定性、NAS 重启自恢复、studio 反代（016b2）、DB 模式。

# PROGRESS · T-WEB-016b1b（NAS 数据布局：KEX_REPO_DIR → kex-repo 快照）

- 同步：studio 仓 metadata 子集（`state decisions workflows docs/plan policy reports jobs/b17_syn_phase2`，排除 `*.mp4`/`*.mov`）tar 管道 → NAS `$BASE/kex-repo`，**15M**；`state/*.json`=123、workflow/plan/policy/frames(6 png) 齐、无 mp4/mov。
- issue 元数据：本机 15 个 `issue-*/issue.json` tar 管道 → NAS `$BASE/data`，`issue-*/issue.json`=**15**，既有文件未动。
- 切换：`.env` `KEX_REPO_DIR=$BASE/kex-repo`（备份 `.env.bak-20261110231020`）→ `compose config` 新挂载 → `up -d`。新容器 `f7a64007088f` healthy，`/kex-repo` ro=true。
- 偏差：旧容器先 stop+rename，但 `compose up -d` 按 label Recreate 删掉了改名容器；已补 `docker create` 同名静态回滚容器 + `.env` 备份。
- 复验：flow jobs=123/latest=issue9_demo_a2/F=failed/shots=12；contract gate=5/thresholds=7/workflow 768×512/49/30/3/6/cutoff=null/inbox=0；issues=15；deliveries=2；qc jobs=2；plan source=files；media 200+Range 206；页面 200；双入口 200（NAS ts/LAN + studio）。
- 证据：`issue-19/evidence-web/tweb016b1b/`；文档 `issue-19/nas-web-deploy.md` 新增「数据布局（016b1b 起）」+「回滚」。
- 未验证：容器长跑/NAS 重启自恢复、回滚容器未实启、studio 反代（016b2，本次未动）。

# PROGRESS · T-WEB-016b2（studio 8088 切 NAS 反代）

- 23:15 备份 + 部署：studio `serve.mjs.bak-tweb016b2` / `plist.bak-tweb016b2`；rsync 016a serve.mjs（sha `a1ea3491…` 本机=远端）。
- 23:15 plist 加 `EnvironmentVariables.UPSTREAM_URL=http://100.123.73.123:8088`，`plutil -lint` OK，diff 仅此键。
- 23:15 重启：PID 43178→**48938** running；启动日志 `upstream=http://100.123.73.123:8088`。
- 23:15 代理硬证据：经 studio POST `/api/issues` → **201**，NAS 实体 `data/issue-31` 出现；容器内 rm 后 GET count 回 **15**（原计划 mv /tmp，因 root 文件 + /tmp 跨 fs 改容器内 rm）。
- 23:18 Playwright 经 studio 1440 七页 + 390 两页：**55/55 PASS**（console/pageerror/4xx5xx=0、无溢出）；flow jobs=123/F failed、gate=5、issues=15、deliveries=2、reports 34/19/2/10/3、qc 2(0/1/1)；截图 `r7/studio-proxy-*.png`。
- 23:18 资产哈希：`index-BgsymiNI.js` studio/NAS/容器 dist 三处均 `9d9a9530…`。
- 23:19 回滚演练（本机 UPSTREAM_URL=127.0.0.1:1, :8096）→ `/`、`/api/flow`、`/api/issues` 均 **502**，自停释放端口；未动 studio/NAS。
- 文档：`issue-19/nas-web-deploy.md` 增「studio 反代切换」；`issue-19/web-v2-final.md` 增部署拓扑；证据 `issue-19/evidence-web/tweb016b2/`。
- 未验证：长跑稳定性、tailscale 断线时行为、`kex-repo`/`data` 快照同步节奏。

# PROGRESS · T-WEB-017a（/api/issues 切 Gitea 数据源）

- 新增 `web/server/gitea.ts`（listIssues/issueSummary/createIssue/giteaConfigured + 错误分类 + 10s 缓存）；`api.ts` 默认走 Gitea，仅 `WEB_ISSUES_SOURCE=files` 走旧本地扫描（deprecated 回退）。
- 契约：`number/title/body/state/assignee.login/标签 A轨|B轨|双轨|P0..P3/html_url/labels/comments`；`meta:{source:"gitea",repo,web_url,counts,fetched_at}`；POST 写 Gitea 不写本地；未配置 200 `available:false`（POST 503）、不可达 `gitea unavailable`、创建失败 502。
- 真验（SSH 隧道 13000 → Gitea 1.22.6）：version 200；**起测基线 35/9/26**（工单的 34/8 已过期，#35 是 11-10 的合法新增）；`/api/issues` open=9、all=36、closed=27（含自检 #36 已关闭）、`limit=5&page=2`=5；number 集合与 3 条字段映射逐项一致；POST 自检 **#36** → open 9→10，关闭后回 9；`GITEA_URL=127.0.0.1:1` → `gitea unavailable`；无认证 → `gitea not configured` + POST 503；`files` 回退 count=15；typecheck/build EXIT 0。
- 事故：8097 被 11-10 遗留的 files 模式服务占用，首轮 noauth 断言打到它并在本地创建 `issue-31`；已把目录移到 `/tmp/tweb017a-stray-issue-31`（本地 issue 数回 15），改 8099 复验。遗留 pid 61474 非本单进程，未处置。
- 证据：`issue-19/evidence-web/tweb017a/`（checks.txt、gitea-issues-all.redacted.json、gitea-counts*.json、mapping-check.txt、post-issue.json、server-*.log、typecheck.log、build-server.log、sha256.txt）。
- 未验证：NAS 容器能否访问 Gitea（网段）、长跑/缓存失效边界、UI 对 `status:"closed"` 的展示（归 017b）。

# PROGRESS · T-WEB-017b（/issues 接 Gitea + 浏览器复验）

- 实现（relay 1，撞步数后转 relay 2）：`/issues` 默认走 Gitea（badge Open/Closed、label chips、外链、新建弹窗 `创建到 Gitea`、空/错/加载态），`typecheck`/`build`/`build:server` EXIT 0；未重排设计、未加依赖。
- 环境（relay 2）：8095 用 `GITEA_URL=http://192.168.3.14:3000`（LAN 直连 version 200），使 `meta.web_url` 与行/弹窗外链为 LAN 地址；8096 `GITEA_URL=127.0.0.1:1` 作错误态；13000 隧道仅给 verify 脚本 PATCH 用；凭据仅驻进程 env。
- 真验：`verify-ui.mjs` **39/39 PASS，diff 全 0**（`ui-checks.json result=PASS`）。API/UI 一致：open=9、all=36、closed=27；全部 tab 36 行、已关闭 27 行（Closed badge 27）；`priority/P2` chip；行 href `http://192.168.3.14:3000/gitadmin/kex-labs-video/issues/35`；popover=9 + 最近 open + Gitea 链接；新建自检 **#38**（201，open 9→10、行高亮）→ PATCH 关闭（201）→ open 9、closed 28、total 37；8096 显示不可达+重试、0 行、无「共 15」；1440/390 console/pageerror/requestfailed=0、`scrollWidth==clientWidth`、390 单列。
- 脚本修正：外部 PATCH 绕过服务端 10s 缓存 → 关单后 reload 轮询（≤30s）再断言（首轮超时即此原因，非 UI 失败）；另加 LAN 前缀严格断言。
- 首轮作废：已建并关 #37，为守「只允许 1 条自检 issue」用 Gitea API DELETE #37（204），计数回 9/27/36 后正式跑出 #38。
- 清理：SIGTERM 8095/8096/遗留 8097（61474）/13000 隧道；`lsof`+`ps` 复核无监听/残留；未动 studio、NAS。
- 证据：`issue-19/evidence-web/tweb017b/`（ui-checks.json、verify-run.log、CHECKPOINT-relay2.md、sha256.txt、server-*.log）+ 截图 `web/screenshots/v2/r8/` 5 张。
- 未验证：外部改动后 ≤10s 缓存窗口（服务端设计）；NAS 部署/长跑归 017c。

# PROGRESS · T-WEB-017d（任务源 Gitea + 34 补建 + NAS 部署）

- 后端：`gitea.ts` task meta/标题解析、`listTaskIssues`、`ensureTaskLabels`、`create/updateTaskIssue`、`reconcileTaskIssues`（dryRun/幂等/只建不删）；`GITEA_WEB_URL` 重写 `html_url`/`web_url`。
- `api.ts`：`WEB_TASKS_SOURCE` 默认 gitea；`readPlanData` 任务读 Gitea（milestones/eta/updated_at 仍取 PLAN_FILE）；PATCH gitea 分支；`POST /api/gitea/reconcile`；overview/weekly/status 跟随。
- 本机真验：dryRun 34 → 实建 34 → 重跑 0/34；plan 34（20/1/10/3）字段逐项等；PATCH 5→0；files 回退 34；url 重写 `100.123.73.123:3000`；8095/8096/8097/13000 清理。
- NAS：secret 600/6 行、compose env_file、镜像 `5b9dbaddfa8e`（prev `458972d0c779`）、容器 healthy、reconcile 0/34、PATCH 5→0；NAS/studio plan 34、issues 72（24/48）。
- 证据：`issue-19/evidence-web/tweb017d/`（verify-gitea 17/17、deploy/、CHECKPOINT、sha256）+ `web/screenshots/v2/r9/` 7 图。
- 偏差：r9 home badge 25 vs 最终 24（差 1，未追查）；`/plan` 无独立路由（是总览「任务计划」区）；长跑/并发 reconcile/外网链接未验证。

# PROGRESS · ISSUE-73 relay 2c（发布 + 终验 + 关单）

- 本机 8095：`verify-r10.mjs` **59/59 PASS**、11 图、console/pageerror 0、横向溢出 0；新增 2 条 token 断言（body `rgb(245,245,247)`、`.glass-sidebar` `blur(20px) saturate(1.8)`）。
- 脚本修正（只修脚本）：风险清单选择器 `#risk-list` → `[data-testid="risk-list"]`（旧选择器恒 0 条，既误报 FAIL 又让背景色检查空数组假通过）。
- NAS：同步 `web-src`（本地/NAS `src+server` 树 sha256 一致）→ `DOCKER_BUILDKIT=0 docker compose build` EXIT=0 → `latest` `2c94e85a9269`，回滚 tag `prev-issue73` `5b9dbaddfa8e` → `up -d --no-build` healthy。
- NAS API：plan 34（20/1/10/3，tasksSource=gitea）、issues 26 open/48 closed/74 total（017d 之后新增 #74/#75）、weekly 34、deliveries 2。
- 远端验证：NAS 52/52、studio 52/52（1440×6 + 390×3），console/pageerror/溢出 0；`remote-*` 9 图。媒体预加载 `ERR_ABORTED` 单列（直连 GET 200 video/mp4）。
- #73 已 close（comment 含实现范围、镜像、验证值、6 条 deferred 与证据路径）。
- 未验证：长跑/重启后缓存、DB、外网访问。
