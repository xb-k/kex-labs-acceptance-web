# Kex Labs · B 轨视频增强验收

**实验中的验收台（设计态）**：任务列表、原片/优化片同步对比（含拖动分割线）、判据逐项、
QC 曲线、项目状态板。所有数字从 acceptance 仓库的真实产物读取，**没有 mock 数据**。

## 启动

```bash
cd /Users/kexinbao/Documents/master-dev/myself/acceptance/web
npm i && npm run dev
# → http://127.0.0.1:5173
```

`npm run dev` 用 Vite 中间件同时提供前端和轻后端（无需另起服务）。其他命令：

```bash
npm run build      # tsc 类型检查 + vite build（TS 零错误）
npm run preview    # 预览构建产物（同样带 API，端口 4173）
npm run typecheck
```

Node 18+（本机验证 Node 22）。默认数据根目录 = `web/` 的上一级（即 `acceptance/`），可用
`WEB_DATA_ROOT=/path/to/acceptance npm run dev` 覆盖。状态文件路径可用
`WEB_STATUS_FILE=/path/to/project-status.json` 覆盖。健康探针默认请求
`http://127.0.0.1:8188/system_stats`，可用 `COMFYUI_URL` 覆盖；连不上就显示离线，不写死在线。

## 部署

### studio（launchd，当前在用）

studio 上常驻服务 `com.kexlabs.web`：自带 Node（`~/kex/acceptance-ui/runtime/node`）跑
`server/serve.mjs`，端口 8088，数据根 `~/kex/acceptance-ui/data`（只读）。拓扑与验收证据见
`../issue-19/web-deploy.md`。

**反向代理模式（最终拓扑）**：给 `com.kexlabs.web` 的 plist 加
`UPSTREAM_URL=http://<NAS-tailscale-ip>:8088` 后，页面本身不再读本地 dist/数据，而是把
**所有请求**（页面、`/api/*`、`/media/*`、Range、HEAD、POST/PATCH）流式转发给 NAS 容器，
浏览器 URL 不变。studio 只做代理，数据只存在于 NAS，避免两边数据漂移。

- 转发头：去掉 hop-by-hop（`connection/keep-alive/proxy-*/transfer-encoding/upgrade` 等），
  设 `host=<upstream>`、`x-forwarded-for`、`x-forwarded-proto=http`、`x-forwarded-host=<原 host>`；
  状态码与响应头（含 `content-range/accept-ranges/content-length`）原样回写。
- 超时只作用于建连 + 首包（30s），管道阶段不设 socket timeout，大文件下载不会被切断。
- 上游不可达：浏览器得到 `502`（超时 `504`）+ 纯文本 `upstream unavailable`，
  具体原因只写服务端日志一行（`[proxy] <method> <path> -> 502/504 (...)`），不泄露内网细节。
- 启动日志出现 `upstream=http://…` 即生效；`upstream=local` 表示本地模式。
- **回滚**：从 plist 删掉 `UPSTREAM_URL`（或改回注释）→
  `ssh studio-ts 'launchctl kickstart -k gui/$(id -u)/com.kexlabs.web'`；本地 dist/data 仍在，
  立即回到直连模式。

更新流程（本机构建 → rsync 产物 → 重启服务）：

```bash
cd web
npm ci && npm run build && npm run build:server

ssh studio-ts 'mkdir -p ~/kex/acceptance-ui/dist ~/kex/acceptance-ui/server'
rsync -a --delete dist/ studio-ts:~/kex/acceptance-ui/dist/
rsync -a server/serve.mjs studio-ts:~/kex/acceptance-ui/server/serve.mjs

# 数据有更新时（只读挂载目录，路径与仓库一致）
rsync -a IMG_3189.MOV studio-ts:~/kex/acceptance-ui/data/
rsync -a issue-19/b-track-s0/ issue-19/b-track-s1/ \
  studio-ts:~/kex/acceptance-ui/data/issue-19/
# 状态文件：acceptance/.opencode/state/project-status.json
rsync -a .opencode/state/project-status.json \
  studio-ts:~/kex/acceptance-ui/data/.opencode/state/

# 重启（KeepAlive 会在数秒内拉起新进程；只动 web，不要动 com.kexlabs.video）
ssh studio-ts 'launchctl kickstart -k gui/$(id -u)/com.kexlabs.web'
curl -s -o /dev/null -w '%{http_code}\n' http://100.92.106.101:8088/
```

> 路径细节：rsync 源要写 `dist/`（尾斜杠同步内容）；`serve.mjs` 是 `build:server` 的打包产物，
> 不是源码。数据目录布局见 `docker-compose.yml` 注释：`IMG_3189.MOV`、`issue-19/b-track-s{0,1}/`、
> `.opencode/state/project-status.json`。

### NAS Docker（发版件已就绪，尚未部署）

入口：`ssh -o ProxyJump=studio-ts ugnas`。部署根：

```bash
BASE='/volume1/小甜豆/KexLabs/10_projects/kex-labs-video/acceptance-web'
# 仓库存于 $BASE/..（含 state/workflows/docs/policy/reports）；web 代码在 $BASE/web-src
```

```bash
# 镜像内已完成 npm ci + build + build:server，运行时只带 dist/ + serve.mjs
docker image tag kexlabs-acceptance-web:latest kexlabs-acceptance-web:prev   # 升级前留回滚点
cd "$BASE"
WEB_DATA_DIR="$BASE/data" \
KEX_REPO_DIR="$BASE/.." \
WEB_LOG_DIR="$BASE/../logs" \
  docker compose -f web-src/docker-compose.yml up -d --build
```

- 端口：宿主 `8088` → 容器 `8088`
- 挂载与变量：
  | compose 变量 | 容器路径 | 模式 | 用途 |
  |---|---|---|---|
  | `WEB_DATA_DIR`（默认 `./data`） | `/data` | **rw** | 验收数据（`IMG_3189.MOV`、`issue-19/b-track-*`、`.opencode/state`）；仅 `WEB_ISSUES_SOURCE=files` 回退模式会写本地 `issue-N/` |
  | `KEX_REPO_DIR`（必填，`:?` 校验） | `/kex-repo` | ro | kex-labs-video 仓库（state/workflows/docs/policy/reports），`KEX_REPO_ROOT` 指向它 |
  | `WEB_LOG_DIR`（默认 `./logs`） | `/logs` | ro | runner 日志，`KEX_LOG_DIR` 指向它 |
- **相对 SPEC 的有意偏差**：`/data` 由 `ro` 改为 **rw**。015c 的 `POST /api/issues` 会往
  `WEB_ISSUE_ROOT`（默认 = 数据根）写 `issue-N/`；T-WEB-017a 起该路径**只在
  `WEB_ISSUES_SOURCE=files` 回退模式使用（deprecated）**，默认 Gitea 模式不写 `/data`。
  审计要求「只读」时改回 `:ro` 并同时设 `WEB_ISSUE_WRITE=0`。
- 健康检查：容器内 `GET http://127.0.0.1:8088/api/jobs` 需 200（30s 间隔 / 5s 超时 / 3 次）
- 校验配置（无需 daemon，`KEX_REPO_DIR` 必填）：
  `KEX_REPO_DIR=/srv/kex/kex-labs-video docker compose -f web-src/docker-compose.yml config`
- 回滚：

```bash
docker compose -f web-src/docker-compose.yml down
docker image tag kexlabs-acceptance-web:prev kexlabs-acceptance-web:latest
docker compose -f web-src/docker-compose.yml up -d --no-build
```

## 数据源（页面实际读取）

| 内容 | 路径 |
|---|---|
| 原片 | `IMG_3189.MOV`（1080×1920、30fps、9.9s、297 帧） |
| S1 优化片 | `issue-19/b-track-s1/out/clip_60fps_s1.mp4`（60fps、9.9s、594 帧） |
| S0 优化片 | `issue-19/b-track-s0/out/clip_60fps_v2.mp4`（60fps、2.0s、120 帧） |
| S1 指标 | `issue-19/b-track-s1/out/summary.json` + `out/metrics.csv` |
| S0 指标 | `issue-19/b-track-s0/summary_v2.json` + `metrics2.csv` |
| 优化点文字 | `issue-19/b-track-s{0,1}/report.md` |
| 判据阈值 | `acceptance/.opencode/state/issue-19-deliverable-gate.md` |
| 项目状态 | `.opencode/state/project-status.json`（编排器写入，`/api/status` 每次请求重读） |
| 任务计划 | 任务默认读 Gitea task issue（见「任务数据源」）；`.opencode/state/tasks.json` 仍提供 milestones/eta/updated_at，并在 `WEB_TASKS_SOURCE=files` 时提供全部任务 |

## 数据源切换（files / Postgres）

默认 **files 模式**：所有读请求现场扫 `WEB_DATA_ROOT` 下的文件（上表）。配了数据库就连
**Postgres 模式**，返回体里 `meta.source` 会变成 `postgres`；数据库不可用或没数据时自动回落
files，不会 500。

```bash
# 方式 A：连接串
DATABASE_URL='postgres://user:pass@host:5432/kexlabs_acceptance' node server/serve.mjs
# 方式 B：离散变量（NAS 的 secrets/pg.env 就是这种，方便 --env-file）
PGHOST=… PGPORT=5432 PGDATABASE=kexlabs_acceptance PGUSER=kexlabs_web PGPASSWORD=… \
  node server/serve.mjs
```

- 两种都配时 `DATABASE_URL` 优先；`PG*` 回退要求 HOST/DATABASE/USER/PASSWORD 四项齐全。
- 客户端固定 `search_path=acceptance`、连接池 `max=4`、`idle_timeout=10s`、`connect_timeout=10s`。
- **回滚 = 不配 `DATABASE_URL`、不配 `PG*`**（或把它们 unset），进程重启即回 files 模式，数据文件零改动。

### 灌数：`server/sync.mjs`（幂等）

```bash
DATABASE_URL=… WEB_DATA_ROOT=/data node server/sync.mjs
# 打印一行 JSON：{"ok":true,"snapshots":{...},"tasks":33,"milestones":4,"jobs":2,…}
```

读的是 files 模式同一批文件，写 9 个 `acceptance.*` 表。幂等含义：第二遍
`tasks/jobs/criteria/metrics/artifacts` 数量不变，`snapshots` 按 `(kind, sha256)` 去重不新增，
只有 `sync_runs` +1。表结构见 `db/schema.sql`（`psql -v ON_ERROR_STOP=1 -f`，可重复执行）。

### 写：`PATCH /api/tasks/:id`

```bash
curl -X PATCH -H 'Content-Type: application/json' -H "X-Web-Token: $WEB_WRITE_TOKEN" \
  -d '{"progress":100}' http://127.0.0.1:8088/api/tasks/T-WEB-004
```

- 未设 `WEB_WRITE_TOKEN` → 503（写关闭）；token 不匹配 → 401。
- 可写字段：`status`（done/running/pending/blocked）、`progress`（0–100 整数）、`owner`、`end_ts`（ISO）；其他字段 → 400。
- files 模式：原子写 `tasks.json`（临时文件 + rename）。
- Postgres 模式：先写 DB（`tasks` upsert + `events` 记 `task.update` + `snapshots` 快照），再导出 `tasks.json`，最后按文件重推 `tasks`/`milestones`；DB 成功但导出失败返回 500 + `dbUpdated:true`。

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串（含口令，勿打日志） | — |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | 无 `DATABASE_URL` 时的离散回退 | — |
| `WEB_DATA_ROOT` | files 模式数据根 | `web/` 上一级 |
| `WEB_STATUS_FILE` / `WEB_PLAN_FILE` | 覆盖状态/计划文件路径 | `<DATA_ROOT>/.opencode/state/{project-status,tasks}.json` |
| `WEB_WRITE_TOKEN` | 打开 PATCH 写入口；同时作为 studio intake 代理的鉴权 token（与 studio LaunchAgent 同值） | 未设 = 只读 / intake 503 |
| `STUDIO_INTAKE_URL` | studio intake 服务地址（#84 桥） | `http://100.92.106.101:8090` |
| `WEB_ISSUE_ROOT` | **仅 `WEB_ISSUES_SOURCE=files`（deprecated 回退）**：本地 issues 扫描/写入根 | `WEB_DATA_ROOT` |
| `WEB_ISSUE_WRITE` | 设为 `0`/`false`/`off` 时 `POST /api/issues` 返回 403（两种数据源都生效） | 开启 |
| `WEB_ISSUE_TOKEN` | 配置后 `POST /api/issues` 必须带同值 `X-Web-Token`，否则 401（两种数据源都生效） | 未设 = 仅同源浏览器请求 + 每 IP 10 次/小时（超限 429） |
| `WEB_ISSUES_SOURCE` | `gitea`（默认，直连 Gitea API）或 `files`（显式回退：扫描本地 `issue-N/`） | `gitea` |
| `WEB_TASKS_SOURCE` | `gitea`（默认，任务读 Gitea task issue）或 `files`（显式回退：读 `WEB_PLAN_FILE`） | `gitea` |
| `WEB_GITEA_SYNC_TOKEN` | reconcile 专用 token（与 `WEB_WRITE_TOKEN` 等价）；两者都未设时 reconcile 仅接受 loopback | — |
| `GITEA_URL` | Gitea 根地址（列表/创建都走它） | `http://192.168.3.14:3000` |
| `GITEA_WEB_URL` | 浏览器打开的 Gitea 根地址：`/api/issues` 的 `item.url`、`meta.web_url` 的 origin 重写成它（保留 path）；不设则同 `GITEA_URL` | 同 `GITEA_URL` |
| `GITEA_REPO` | issue 仓库 `owner/repo` | `gitadmin/kex-labs-video` |
| `GITEA_TOKEN` | Gitea token（`Authorization: token …`），与下面的 user/pass 二选一 | — |
| `GITEA_USER` / `GITEA_PASS` | Basic Auth 账号/口令（与 `GITEA_TOKEN` 二选一） | — |
| `PORT` / `HOST` | 监听端口/地址 | `8088` / `0.0.0.0` |
| `WEB_DIST_DIR` | 前端产物目录 | `web/dist` |
| `COMFYUI_URL` | 健康探针地址 | `http://127.0.0.1:8188` |
| `KEX_REPO_ROOT` | `/api/flow`、`/api/contract`、`/media/kex` 读取的 kex-labs-video 仓库根（只读） | `<DATA_ROOT>/kex-repo`（缺失 → `available:false`） |
| `KEX_LOG_DIR` | `/api/flow` 读取 worker 日志的目录 | `~/Library/Logs/kexlabs-video`（缺失 → `logs.worker.lines:[]`） |

### issues 数据源（T-WEB-017a）

`/api/issues` 的唯一数据源是 Gitea（`server/gitea.ts`），与
`http://192.168.3.14:3000/gitadmin/kex-labs-video/issues` 保持一致：

- `WEB_ISSUES_SOURCE` 默认 `gitea`；只有显式 `files` 才回到旧的本地 `issue-N/` 扫描
  （`WEB_ISSUE_ROOT` 旧逻辑保留，label 为 deprecated/回退，不再默认写本地目录）。
- 凭据只从环境变量读取，推荐放在 **`secrets/gitea.env`（不提交）**，由部署脚本 `set -a; . secrets/gitea.env; set +a`
  后注入；`GITEA_TOKEN` 与 `GITEA_USER`/`GITEA_PASS` 二选一。凭据不进日志/响应/证据文件。
- 超时 8s；列表缓存 10s（按 `state/limit/page`）；`POST` 成功后立即失效缓存。
- 字段映射：`number/title` 原样；`description ← body`；`status ← state`（`open|closed`）；
  `owner ← assignee.login`（**不拿 author 冒充**）；`rail ←` 标签名精确 `A轨|B轨|双轨`；
  `priority ←` 标签名精确 `P0..P3`；`url ← html_url`（origin 按 `GITEA_WEB_URL` 重写，path/search 保留）；
  `labels` 原样 `{name,color}`；`comments` 数字；
  `dir:null`、`source:"gitea"`。
- `meta.counts` 由一次 `state=all&limit=50`（超出 50 时用 `X-Total-Count`）计算 `{open,closed,total}`。
- 错误语义：未配置 → 200 `{available:false,reason:"gitea not configured"}`（POST 503）；
  401/403 → `reason:"gitea auth failed"`；不可达/超时 → `reason:"gitea unavailable"`；
  其他上游错误 → `reason:"gitea upstream error"`；创建失败 → 502 `{error:"gitea create failed"}`，均不泄密。
- 自检方式（本机 SSH 隧道）：

```bash
ssh -f -N -L 13000:192.168.3.14:3000 studio-ts
GITEA_URL=http://127.0.0.1:13000 GITEA_USER=… GITEA_PASS=… PORT=8095 \
  WEB_DATA_ROOT=$PWD/.. node server/serve.mjs
curl -s http://127.0.0.1:8095/api/issues | jq '{available,count,counts:.meta.counts}'
curl -s 'http://127.0.0.1:8095/api/issues?state=all&limit=50' | jq '.count'
```

## 任务数据源（T-WEB-017d）

看板/`/plan`/`/status`/`/reports`/`PATCH /api/tasks/:id` 的任务数据默认读 Gitea
（`WEB_TASKS_SOURCE=gitea`）；`files` 是显式回退，读 `WEB_PLAN_FILE`（默认
`.opencode/state/tasks.json`）**全部**字段。

- **任务 issue 识别**：body **首行**必须是单行注释
  `<!-- acceptance:task {"id":"T-WEB-006",…} -->`，或标题以 `[<id>]` 开头
  （`^\[T-[A-Z]+-\d+[a-z]?\]`）。两条都不满足的 issue 不进看板，但仍出现在 `/issues`
  （例如里程碑/自检 issue）。
- **meta 字段**：`id`（必填）、`owner`、`rail`（`A|B|both`）、`status`
  （`done|running|pending|blocked`）、`start`/`end`（ISO）、`progress`（0–100 整数）、
  `depends_on`（数组）、`blocked_by`、`evidence`、`estimated`。非法/缺失的字段在读取时
  回落到空值（`status→pending`、`rail→both`、`progress→0`），不会导致整条任务消失。
- **标题**：`[<id>] <title>`；读取时前缀会被剥掉，`title` 与本地 `tasks.json` 一致。
- **标签**（缺失时 reconcile 自动创建，颜色 = 状态语义色）：

  | 标签 | 颜色 | 含义 |
  |---|---|---|
  | `source/acceptance` | `#8E8E93` | 该 issue 由 acceptance 看板维护 |
  | `status/pending` | `#8E8E93` | 未开始 |
  | `status/running` | `#0071E3` | 进行中 |
  | `status/blocked` | `#C77700` | 阻塞 |
  | `status/done` | `#30A14E` | 已完成（issue 同步 `state=closed`） |
  | `rail/A` / `rail/B` / `rail/双轨` | `#0071E3` / `#5E5CE6` / `#8E8E93` | 轨别 |

- **补建：`POST /api/gitea/reconcile?dryRun=1`**：读 `WEB_PLAN_FILE` 的全部任务，
  拉 Gitea 全量 issue 按 `meta.id`/标题前缀建索引，**缺失才创建**（`done` 建完再
  PATCH `state=closed`），已存在跳过；**只建不删不改**，可重复执行。返回
  `{dryRun,total,missing,created,skipped,ids}`。认证：`X-Web-Token` 匹配
  `WEB_WRITE_TOKEN` 或 `WEB_GITEA_SYNC_TOKEN`；两者都未配置时仅 loopback 可调用（其余 403），
  token 不符 401，非 POST 405，Gitea 失败 502。
- **读取**：`GET /api/plan` 的 `data.tasks` 来自 Gitea（按状态组 `done→running→pending→blocked`，
  组内 `end` 升序、无 `end` 殿后、再按 `id`）；`milestones`/`eta`/`updated_at` 仍取
  `WEB_PLAN_FILE`（或 Postgres 快照）。`meta.tasksSource="gitea"`；Gitea 不可达时
  `data.tasks:[]` + `meta.error="gitea unavailable"`（**不读文件冒充**）。`/api/overview`
  自动跟随并在 `meta.tasksSource` 暴露来源，`/api/reports/weekly` 用同一份任务列表。
- **写**：`PATCH /api/tasks/:id` 在 Gitea 模式按 `meta.id` 找 issue，合并 meta（保留
  非任务标签）、重写首行、同步 `status→state`（`done=closed`，其余 open），返回
  `{task,dbUpdated:false,source:"gitea"}`；任务不存在 404，Gitea 失败 502；
  `WEB_WRITE_TOKEN` 语义与 files 模式一致（未设 503 / 不符 401）。
- **缓存**：任务列表缓存 10s；reconcile 与 PATCH 成功后立即失效（`invalidateGiteaCache`）。

## API

| 端点 | 作用 |
|---|---|
| `GET /api/jobs` | 扫描 `issue-19/b-track-*` 真实产物，生成任务列表 |
| `GET /api/metrics/:jobId` | 读 summary，派生判据卡、参数表、数据来源 |
| `GET /api/qc/:jobId` | 解析 `metrics.csv` / `metrics2.csv`，返回逐帧曲线数据 |
| `GET /api/status` | 读 `.opencode/state/project-status.json`，返回项目状态板数据 |
| `GET /api/plan` | 返回里程碑 + 全部任务计划；任务默认来自 Gitea（`meta.tasksSource:"gitea"`，不可达 → `tasks:[]` + `meta.error`），`WEB_TASKS_SOURCE=files` 时读 `tasks.json` |
| `GET /api/overview` | 工作台总览：任务/判定计数、告警、运行中/待办、系统与交付摘要（`meta.planSource`/`jobsSource`） |
| `GET /api/deliveries` | 交付列表（成片、海报、报告、评分、gate、时长） |
| `GET /api/issues?state=open\|all\|closed&limit=50&page=1` | **默认 Gitea 数据源**：`GET /api/v1/repos/<repo>/issues?type=issues&sort=recentupdate&direction=desc`，默认 `state=open`；返回 `{available,items,count,latest,meta:{source:"gitea",repo,web_url,counts:{open,closed,total},fetched_at}}`；字段映射见下节。未配置/不可达/401 → 200 `available:false`（不回退本地，避免与 Gitea 不一致） |
| `POST /api/issues` | **默认 Gitea 数据源**：在 Gitea 新建 issue（201，`{item,meta}`），负责人/轨道/优先级写进 body 的尾部块；不写本地 `issue-N/`。校验失败 400、写关闭 403、token 不符 401、未配置 503、Gitea 失败 502；请求体超过 20KB → 413、同源无 token 时每 IP 10 次/小时超限 → 429；`title` ≤200 字符，`labels` 仅接受白名单（`P0`~`P3`、`A轨`/`B轨`/`双轨`、`status/*` 等，最多 10 个） |
| `GET /api/jobs/:jobId` | 单个 job 详情（判据 + 产物） |
| `GET /api/tasks/:id` | 任务详情（任务 + 判据 + 证据 + 产物 + 日志 + 历史/快照），不存在 404 |
| `PATCH /api/tasks/:id` | 改任务字段（需 `X-Web-Token`）：Gitea 模式改 issue meta/标签/state（`source:"gitea"`），files/Postgres 模式改 `tasks.json`/DB |
| `POST /api/gitea/reconcile?dryRun=1` | 幂等补建缺失的 task issue，返回 `{dryRun,total,missing,created,skipped,ids}`；token = `WEB_WRITE_TOKEN`/`WEB_GITEA_SYNC_TOKEN`，均未配时仅 loopback |
| `GET /api/system` | Studio 在线探测 + VRAM/RAM/队列（实时探 ComfyUI，不走 DB） |
| `GET /api/qc/summary` | 各 job 的 QC 汇总（同一份 metrics 聚合） |
| `GET /api/health` | 真实探测 ComfyUI `/system_stats`（1.5s 超时） |
| `GET /api/flow?job=` | 自动编排监看：`state/*.json` 列表 + 指定 job 的 stages/shots/frames/decisions/reports + worker 日志尾部；无编排 state 的 job（如 `b-track-s1`）返回 `job:null`，未知 id 404 |
| `GET /api/contract` | 渲染契约（只读）：gate 阈值（来自 gate 文档）/ `quality_thresholds` / ltxv workflow（既有 `params` + 节点图 `available/reason/sha256/nodes/links/stats/catalog`，ComfyUI API 格式反解、无坐标）/ recent 报告 / inbox 队列；`cutoff` 恒 `null` |
| `GET /api/reports/weekly?days=7` | 周报：任务计数、偏差（超期）、风险（blocked+overdue）、里程碑；燃尽仅当 DB 快照足够时生成，否则 `null` + note |
| `GET /media/kex?path=` | kex 仓库 `jobs/**` 下白名单媒体（png/jpg/jpeg/webp/mp4），防穿越；支持 `download=1` 与 Range |
| `GET /media/artifact?path=` | 按相对路径取证据文件（限定数据根内，防穿越） |
| `GET /media/poster/:jobId` | 成片首帧海报（`poster-original` 为原片首帧） |
| `GET /media/original` | 原片，支持 HTTP Range（拖动/seek 必需） |
| `GET /media/out/:jobId` | 该 job 的成片，支持 HTTP Range |

Range 行为：带 `Range: bytes=...` 返回 `206` + `Content-Range`，越界返回 `416`。


### `/api/plan` 契约

```jsonc
{
  "path": "/…/acceptance/.opencode/state/tasks.json",
  "exists": true,                 // false → 页面显示「无任务计划文件」，不推测、不绘制甘特图
  "updatedAt": "2026-11-10T17:30:00+08:00", // 优先 data.updated_at，否则文件 mtime
  "data": {
    "updated_at": "2026-11-10T17:30:00+08:00",
    "timezone": "Asia/Shanghai",  // 可选；页面固定按 Asia/Shanghai 格式与刻度
    "note": "…",                  // 可选，计划摘要脚注
    "milestones": [
      { "id": "M1", "label": "单镜样片", "at": "2026-11-10T18:00:00+08:00", "state": "in_progress", "estimated": true }
    ],
    "tasks": [
      {
        "id": "T-VID-070",
        "title": "A 轨 S0（1 静 1 动 5s）",
        "owner": "video-dev",
        "rail": "A",              // A | B | both | 用户 | master
        "status": "blocked",      // done | running | pending | blocked
        "start": "2026-11-10T19:30:00+08:00",
        "end": "2026-11-10T21:00:00+08:00",   // 进行中任务为「预计完成」
        "progress": 0,            // 0-100；甘特图内条只在 running 时绘制
        "depends_on": ["T-VID-071", "download"],
        "blocked_by": "q8/gemma 下载 + T-VID-071", // 可选
        "evidence": "issue-19/…", // 可选
        "estimated": true         // 可选，表格标「估」
      }
    ],
    "eta": { "best_case_days": 3, "base_case_days": 6, "worst_case_days": 14 }
  }
}
```

路径可用 `WEB_PLAN_FILE` 覆盖，默认 `DATA_ROOT/.opencode/state/tasks.json`。

### 状态页（`/status`）

- **计划概览**：任务总数与四态计数、计划跨度、`updated_at`、ETA 三档。
- **甘特图**：左列固定任务（id + 标题，sticky），右侧按 `start → end` 画条；
  日刻度 + 周标签、里程碑虚线（M0~M3，带时间）、今天竖线；状态色 done 灰 / running 蓝（内条为进度）/
  pending 淡蓝 / blocked 琥珀斜纹；`blocked_by` 显示在条尾，`depends_on` 在行内小字。
  无图表库（纯 CSS/SVG 定位），视口窄时横向滚动、左列保持可见。
- **全部任务**：全部任务（含已完成）按开始时间升序，列含负责人 / 轨道 / 状态 / 进度 / 开始 /
  预计完成 / 时长 / 依赖或阻塞 / 证据，并有状态筛选 chips 与计数。
- 响应 `meta`：`{source:"files|postgres", tasksSource:"gitea|files", error?}`。Gitea 模式下
  `data.tasks` 来自 task issue（`milestones`/`eta`/`updated_at` 仍取 `tasks.json`）；Gitea 不可达时
  为 `tasks:[]` 且带 `meta.error`，**不回落读文件**；`WEB_TASKS_SOURCE=files` 时行为同旧版
  （只读 `tasks.json`，文件缺失时整块显示「无任务计划文件」），不含模拟数据。

### `/api/status` 契约

```jsonc
{
  "path": "/…/acceptance/.opencode/state/project-status.json",
  "exists": true,                 // false → 页面显示「无状态文件」，不推测任何数字
  "updatedAt": "2026-11-10T16:45:00+08:00",
  "data": {
    "updated_at": "2026-11-10T16:45:00+08:00",
    "updated_by": "master",       // 可选
    "milestones": [               // 里程碑
      {
        "id": "M0",
        "name": "核实与工具链",
        "state": "done",          // done | in_progress | pending
        "detail": "…",            // 可选
        "evidence": ["issue-19/…"], // 可选
        "rails": [                // 可选：同一里程碑内的多轨状态
          {
            "rail": "B",
            "state": "conditional_pass", // pass | conditional_pass | blocked
            "detail": "…",
            "blocked_by": ["…"]   // 可选
          }
        ]
      }
    ],
    "now": [{ "task": "…", "detail": "…", "owner": "…" }],          // 当前在做
    "missing": [{ "item": "…", "blocked_by": "…", "why": "…", "impact": "…" }], // 缺什么
    "verdict_rules": { "B1_ssim": ">=0.80" },                        // 判定规则（原样展示）
    "eta": {
      "best_case_days": 3,
      "base_case_days": 5,
      "worst_case_days": 8,
      "assumption": "…"
    }
  }
}
```

## `/flow` · `/pipeline` 契约（T-WEB-015d1）

数据源：`KEX_REPO_ROOT`（默认 `DATA_ROOT/kex-repo`，缺失时 3 个端点都返回 `{available:false, reason:"kex repo not configured"}` + 200；weekly 另有 `plan file missing`）。所有读路径 realpath 后必须落在根内，越界拒绝；坏 JSON 跳过并写入 `meta.warnings[]`。同一 state/decisions 文件有 5s mtime 缓存。

```jsonc
// GET /api/flow?job=<id>
{
  "available": true,
  "jobs": [{ "id": "issue9_demo_a2", "updated_at": "2026-11-09T19:25:34+08:00", "size": 168000 }], // state/*.json 只 stat，按 mtime 降序
  "job": null, // 或 { id, stage, updated_at, duration_s,
               //   stages:[{key,status,duration_s,updated_at,tools:[{name,status,duration_ms,attempts,error,cached,skipped,artifact}]}],
               //   shots:[{shot_id,start,end,duration_s}], frames:[{shot_id,frame_ts,path,exists}],
               //   semantics, shot_semantics, profile, probe, cold_warm, quality, quality_gate,
               //   artifacts:[{path,exists}], decisions:[…≤20], reports:{render,assemble,interpolate} }
  "logs": { "worker": { "path": "…/worker-launchd-stdout.log", "lines": ["…≤200"] }, "lock_events": ["…≤50"] },
  "meta": { "root": "/…/kex-labs-video", "generated_at": "…", "warnings": [] }
}
// job 缺省=最新；`?job=b-track-s1` → 200 {job:null, reason:"no_orchestrator_state", message:"B 轨走独立增强链，无编排 state"}；未知 id → 404 {error:"job not found"}

// GET /api/contract
{ "available": true,
  "gate": { "source": "docs/plan/<latest dual-track>.md", "updated_at": "…", "items": [{ "key": "A1", "name": "单镜无崩坏", "threshold": "≥16.3", "source_line": "| A1 | … |" }] },
  "thresholds": { "source": "policy/quality_thresholds.json", "items": [{ "key": "skin_texture_energy", "op": ">", "value": 3.15, "unit": "…" }] },
  "workflow": {
    "available": true,                              // 文件存在且反解出 ≥1 节点；否则 false
    "reason": null,                                 // available=false 时："workflow file missing" / "workflow json invalid" / "workflow has no nodes"
    "source": "workflows/ltxv_i2v_v1.json",
    "name": "ltxv_i2v_v1",
    "sha256": "<64 hex>",                           // 真实文件字节哈希（与 JSON 解析同一次读取）；文件缺失 null
    "params": { "width": 768, "height": 512, "length": 49, "fps": 30, "cfg": 3, "steps": 6, "denoise": 1, "seed": 0, "sampler": "euler", "scheduler": "normal", "ckpt": "…safetensors" }, // 既有 11 键口径不变；只取 number/string 标量，数组/对象 → null
    "cutoff": null,
    "nodes": [{ "id": "1", "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "…" } }], // 按 JSON 对象键序（整数数字键升序）
    "links": [{ "from": "2", "from_slot": 0, "to": "3", "to_input": "clip" }],                       // 由 inputs 的 ["<nodeId>", slot] 反解；from/to 必须都在 nodes 内（字面量数组如 [512,768] 不成边）
    "stats": { "node_count": 11, "link_count": 16, "classes": ["CLIPLoader", "…"] },                 // classes 去重升序
    "catalog": [                                    // workflows/ 下 *.json，只计数不返回图（上限 200 文件 / 2MB）
      { "name": "ltxv_i2v_v1", "source": "workflows/ltxv_i2v_v1.json", "node_count": 11, "link_count": 16, "primary": true },
      { "name": "sdxl_txt2img_v1", "source": "workflows/sdxl_txt2img_v1.json", "node_count": 7, "link_count": 9, "primary": false }
    ]
  },
  "recent": { "job": "…", "probe": {…}|null, "render_report": { "memory": {…} }|null, "assemble_report": {…}|null },
  "queue": { "inbox": [], "pending": [], "done": [], "failed": [], "rejected": [], "running": [] },
  "meta": { "root": "…", "generated_at": "…", "warnings": [] } }
// workflow 节点图：只读、ComfyUI API 格式、无坐标、前端自动布局；不读 ComfyUI、不执行 workflow
// 缺失/坏 JSON → available:false + reason，nodes/links=[]、stats 全 0、params 仍按 null 口径（不编造）
// workflows/ 为指向仓库外的 symlink 时 catalog=[] + warnings；catalog 超 200 文件 / 2MB 跳过并 warnings

// GET /api/reports/weekly?days=7
{ "available": true,
  "period": { "from": "…", "to": "…", "days": 7 },
  "summary": { "tasks": { "total": 34, "done": 20, "running": 1, "pending": 10, "blocked": 3 }, "completion_rate": 0.588, "deliveries": { "count": 2, "repaired": 1 } },
  "burndown": null,  // 仅 dbEnabled() 且 snapshots 近 N 天 ≥2 条时从 DB 算，否则 null
  "deviations": [{ "task_id": "…", "title": "…", "owner": "…", "status": "running|blocked", "end_ts": "…", "overdue_days": 0, "progress": 0 }],
  "risks": [{ "level": "blocked|overdue", "task_id": "…", "text": "…" }],
  "milestones": [ … ],
  "velocity": null,  // { completed_per_day } | null
  "meta": { "source": "files|postgres", "note": "无历史快照（DB 未启用）" } }
// 无 PLAN_FILE → 200 {available:false, reason:"plan file missing"}

// GET /media/kex?path=jobs/…（只允许 jobs/** 下 png/jpg/jpeg/webp/mp4）
// realpath 必须在 KEX_REPO_ROOT 内；越界 403、非白名单 400/404；`download=1` 附件下载；复用 Range（206）
```

## 新增一个 job

1. 在 `acceptance/issue-19/` 下建目录 `b-track-s<编号>/`（必须匹配 `b-track-s\d+`）。
2. 放入判据数据：优先 `out/summary.json`，否则 `summary_v2.json` / `summary.json`。
   - 若有 `gates` 对象（`B1_ssim>=0.80` 这类键），页面按 gates 判 PASS/FAIL；
   - 若只有 `verdict` 字符串，页面原样展示，不重判；
   - 都没有 → 显示「无判定」。
3. 放入 `out/*.mp4`（同目录多个 mp4 时取体积最大的那个），可选 `out/metrics.csv` 或 `metrics2.csv`（QC 曲线）。
4. 放 `report.md`（可选）：H1 作标题；`取样：t=A~Bs` 会用作原片片段偏移。
5. 刷新页面即可，无需改代码。新增后若 3 秒内没出现，硬刷新一次（服务端有 3s 扫描缓存）。
6. 状态板不随 job 自动变：由编排器更新 `.opencode/state/project-status.json`，
   `/api/status` 每次请求重读该文件，保存后刷新页面即可。

## 结构

```
web/
├── server/api.ts        # 扫描 + API + Range 媒体服务（Vite 中间件）
├── src/pages/           # 任务列表 / 详情 / QC / 项目状态
├── src/components/      # 播放器、判据卡、参数表、SVG 曲线、状态胶囊、甘特图/任务表
├── src/plan.ts          # 计划时间格式化与状态语义（Asia/Shanghai）
├── server/api.ts        # /api/status 读 project-status.json；/api/plan 读 Gitea task issue（files 回退 tasks.json）
└── DESIGN.md            # 方向与 token
```
