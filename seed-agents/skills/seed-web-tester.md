---
name: web-tester
description: 用例驱动的 Web 自动化验收 + 1080P 录屏交付（Playwright + 系统 Chrome）。当用户提到 Web 自动化测试、UI 验收、浏览器 E2E、页面回归、把操作过程录成视频交付、写 Playwright 脚本时使用。**Use ONLY for Web UI/E2E or demo recording; 单元测试/API/CLI 测试不要用本技能**。用例 YAML 是唯一真相源，脚本只是执行器；默认不录屏，只有明确要视频/演示/汇报/交付时才录。
---

# web-tester：用例驱动的 Web 验收 + 录屏交付

一句话：**先把用例写死（含可判真假的期望值），再让执行器去跑；字幕来自用例，不来自代码。**

## 铁律

1. **用例先写、先冻结**：动手实现前把用例写完，记下 `sha256`（`result.json.frozenCasesSha256` 必须与冻结值一致）。实现期间不许改判据 —— 判据松了就重新冻结并说明原因。
2. **用例只从需求 / AC / spec 写，不读实现反推**。读实现写出来的用例只是把 bug 固化下来。
3. **字幕只来自用例的 `caption`**，业务代码里禁止出现 `step('...')` 之类的手写步骤文案。改了文案 = 改了用例 = 重新冻结。
4. **每条用例必须有可判真假的期望值**：`text/attr/value` 非空字符串，`count` 是数字。禁止「验证功能正常」「页面无异常」这类空断言（执行器会 `CASE-INVALID` 拦下）。
5. **录屏开关自动判定，默认不录**：不要每次问用户 Y/n。按下面「什么时候录 / 不录」表判定，默认 **不录**；**只有任务里出现「录屏/视频/演示/汇报/交付/给客户看」等意图才录**。拿不准就默认不录，并在汇报里一句话说明（例：`本次按回归跑，未录屏；需视频加 --present`）。

## 什么时候录 / 不录（默认不录）

| 场景 | 录不录 | 怎么跑 |
|---|---|---|
| 单元测试 / 接口测试 / 代码层回归 | ❌ 不用本技能 | 用 pytest/vitest 等 |
| Web 功能回归 / CI / 冒烟 | ❌ 不录 | `--no-record`（headless，trace+result.json 足够） |
| 失败复现 / 排查 flaky | ❌ 不录（默认） | `--no-record` + trace；需要看画面才 `--headed` |
| 用户要“看一遍/验收” | ✅ 录 | `--record` + `hud: subtitle` |
| 对外汇报 / 演示 / 交付视频 | ✅ 录 | `--present`（章节卡+光标+STEP 卡+spotlight） |
| 演示第三方站点 | ✅ 录 | `--present` + `--storage`（人工登录一次） |

判定优先级：CLI `--no-record` > CLI `--record` > `meta.presentation: true`（隐含录）> `meta.record` > **默认 false**。

## 工作流

| 步 | 做什么 | 产出 |
|---|---|---|
| ① 写用例 | 从 AC 出发写 `cases.yaml`，正/边/负都覆盖 | `cases.yaml` |
| ② 冻结 | `shasum -a 256 cases.yaml \| tee cases.sha256` | 判据哈希 |
| ③ 跑 | `node run.mjs --cases cases.yaml --out runs --no-record`（要视频见下表再加 `--record`/`--present`） | 退出码 + 控制台短表 |
| ④ 交付 | 把 `result.json` + `trace/*.zip` 一起给；录屏场景再加 `deliverable/*.mp4` + `subtitles/*.srt` | 可验收的证据包 |

```bash
cd ~/.config/opencode/skills/web-tester          # 依赖已装好（playwright-core + yaml）

# 默认：回归/冒烟，不录屏（只出 result.json + 失败截图 + trace）
node run.mjs --cases ./cases.yaml --out ./runs --no-record
node run.mjs --cases ./cases.yaml --no-record --only TC-AUTH-001

# 只有明确要视频时才录：
node run.mjs --cases ./cases.yaml --record       # 验收/看一遍
node run.mjs --cases ./cases.yaml --present      # 对外汇报/演示（章节卡+光标+STEP 卡+spotlight）
```

## 用例质量清单

一条合格用例必须回答：**谁**（id/ac）、**什么类型**（type）、**前提**（preconditions）、**怎么走**（steps，每步一个动作 + 一句人话 caption）、**怎么算过**（expect，硬值）、**证据在哪**（result.json 里的 evidence 列表）。

- `id` 唯一、`ac` 指回需求条目、`type` ∈ `positive|edge|negative`。
- 前置条件写清：服务已启动 / 鉴权模式 / 需要的环境变量。
- **正-边-负都要有**：同一 AC 至少 1 条正 + 1 条负；边界（空列表、0 条、上限、非法输入）单独一条。
- 每条用例独立 `context`（cookie/localStorage 隔离），所以用例必须自己走到起始状态，不要依赖上一条。
- 录屏模式每步一张截图 + 失败必截 + trace，证据齐了才算交付。

## 字段速查

### meta

| 字段 | 说明 |
|---|---|
| `name` | 用例集名字（给人看）；演示模式下同时显示在步骤卡右上角，**没写就不显示** |
| `baseUrl` | 起始地址；`--base-url` 可覆盖 |
| `viewport` | 默认 `{width:1920,height:1080}`；录屏抓帧尺寸 = viewport，帧率固定 30fps |
| `locale` | 默认 `zh-CN` |
| `timeoutMs` | 单动作/单断言超时，默认 15000 |
| `record` | 是否录屏，**默认 false**（不录）；`meta.presentation: true` 隐含 true；CLI `--record/--no-record` 覆盖（CLI 优先） |
| `presentation` | `true` = 对外汇报演示模式（默认 false；CLI `--present` 等价，并隐含录屏）。打开后 `hud` 默认 `card`、`focus` 默认 `spotlight` |
| `hud` | `subtitle`（默认）/ `card` / `both`：底部字幕 / 右下步骤卡 / 两者都要。显式写了以显式值为准 |
| `hudPosition` | 步骤卡位置：`bottom-right`（默认）/ `bottom-center` / `bottom-left` / `top-center`。只作用于卡片；`hud: "both"` + `bottom-center` 时底部字幕自动上移到卡片上方（间距 12px，按卡片实时高度算）。非枚举值 → `CASE-INVALID` |
| `focus` | `ring`（默认，蓝色描边）/ `spotlight`（目标外压暗）。显式写了以显式值为准 |
| `dim` | spotlight 的压暗强度，默认 `0.45` |
| `mask` | 录像里要打码的选择器数组（`filter: blur(5px)`，不改元素值、不影响断言） |
| `maskPasswords` | 默认 true：`input[type=password]` 自动打码 |
| `storageState` | 登录态 JSON 路径（**相对用例文件目录**），传给 `browser.newContext({ storageState })` |

### step

```yaml
- caption: 点击登录        # 必填，中文，= 录屏字幕 / SRT 唯一来源
  title: 点击登录          # 可选，卡片主行（缺省 = caption）
  detail: 提交后进入会话列表 # 可选，卡片副行（缺省不显示）
  action: click
  target: {...}           # 见下表
  value: ...              # fill/type/select 必填
  url: /login             # goto 必填（相对 baseUrl）
  key: Enter              # press 必填
  ms: 800                 # waitForTimeout 必填
  files: /abs/a.pdf       # upload 必填（字符串或数组）
  speed: 2                # 可选：该步整体倍速（>1 加速，<1 放慢；只影响成片观看时长）
```

`title` / `detail` 一旦写了就必须是非空字符串（不能给卡片留空行）；`caption` 永远必填。

`action`：`goto | click | fill | type | select | check | uncheck | press | hover | waitFor | waitForTimeout | upload | scrollTo | reload | goBack | screenshot`

### target

| `by` | 必带字段 | 例 |
|---|---|---|
| `testid` | `value` | `{ by: testid, value: conversation-list }` → `[data-testid]` |
| `role` | `role`（可选 `name`） | `{ by: role, role: button, name: 登录 }` |
| `label` | `value` | `{ by: label, value: 用户名 }` |
| `text` | `value` | `{ by: text, value: 保存 }` |
| `placeholder` | `value` | `{ by: placeholder, value: 请输入邮箱 }` |
| `css` | `value` | `{ by: css, value: .conversation-item }` |
| `alt` / `title` | `value` | `{ by: title, value: 关闭 }` |

### expect

| `type` | 需要 | 说明 |
|---|---|---|
| `url` | `value` + `match` | 默认 contains；`exact` 时比对完整 URL 或 pathname |
| `visible` / `hidden` | `target` | 轮询到超时为止 |
| `text` | `target` + `value` | `match: contains`（默认）/ `exact` |
| `count` | `target` + 数字 `value` | `cmp: eq`（默认）/ `gte` / `lte` |
| `attr` | `target` + `name` + `value` | 默认 exact，可 `match: contains` |
| `value` | `target` + `value` | 输入框当前值，默认 exact |

变量替换：任意字符串里写 `${ENV_VAR}`，从 `process.env` 读；**缺失直接 `CASE-INVALID` + exit 2**，不会静默变空串。

## CLI

```
node run.mjs --cases <yaml> [--base-url URL] [--record|--no-record] [--headed] [--out DIR] [--only TC-ID]
             [--present] [--storage PATH] [--save-storage PATH]
             [--crf N] [--preset NAME] [--speed N] [--wait-speed N] [--wait-hold MS] [--wait-min MS] [--no-speed]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--crf <0-51>` | `18` | 转码画质，越小画质越好、文件越大（0 = 无损级） |
| `--preset <name>` | `slow` | x264 preset：`ultrafast…veryslow`，越慢同画质文件越小 |
| `--speed <n>` | `1` | **全局**倍速（≥1），与等待段/步级倍速**相乘** |
| `--wait-speed <n>` | `6`（`--present`）/ `1`（其余） | **等待段**（实测阻塞 ≥ `--wait-min` 的任意段）的倍速 |
| `--wait-hold <ms>` | `1500` | 每段等待先按正常速度保持这么久，再开始加速 |
| `--wait-min <ms>` | `2000` | 实测阻塞多久才算「等待段」值得压（`0` = 只要有阻塞就压） |
| `--no-speed` | - | 等价 `--speed 1 --wait-speed 1`（真实时间轴，证据用） |

- 浏览器：`chromium.launch({ channel: PW_CHANNEL || 'chrome', headless: !record })`，`--headed` 强制有头。
- 录屏默认 **off**：不带 flag = 不录（`headless` + trace + result.json）。`--record` 才录。
- `--present`：等价 `meta.presentation: true`（CLI 优先），并隐含录屏；`--present --no-record` 仍然不录（CLI `--no-record` 优先）。**`--present` 默认 `--wait-speed 6`**（演示要能看下去），`--record` 回归视频默认 1x；命令行显式传参一律优先。
- `--storage <path>`：覆盖 `meta.storageState`，复用登录态；文件不存在 → 配置错误 exit 2。
- `--save-storage <path>`：**单独模式**——有头打开 baseUrl → 终端提示「请完成登录（含验证码/2FA），完成后按 Enter」→ 等回车 → 存 `storageState` → exit 0。**不录屏、不跑用例**；`--cases` 可省略（那就用 `--base-url`）。保存目录不存在会自动创建。
- 退出码：`0` 全 PASS ／ `1` 有 FAIL ／ `2` 配置或用例非法（**不启动浏览器**）。
- 结构校验在启动浏览器之前做：缺 `expect`、`caption` 非中文、`action` 未知、`count` 非数字、变量缺失、`hud/focus` 非法、`title/detail` 空串、`speed` 非正数、`--crf/--preset/--speed/--wait-speed/--wait-hold/--wait-min` 非法 → `CASE-INVALID` / `配置错误` + exit 2。

## 产物

```
<out>/<runId>/
  result.json                     # frozenCasesSha256 / presentation·hud·hudPosition·focus·mask·storageState / crf·preset·speed / 每条用例 status + steps + speed.applied + source_duration_ms + spans + evidence / summary
  deliverable/<caseId>.mp4        # 1080P h264 / 30fps / CRF 18 / preset slow / yuv420p bt709，章节卡 + 光标 + 目标框 + 字幕/步骤卡 + 失败提示都在画面里
  subtitles/<caseId>.srt          # 字幕 = 每步 caption（加速时已重映射到成片时间轴）
  screenshots/<caseId>-<步>-<slug>.png
  screenshots/<caseId>-<步>-<slug>-FAIL.png | <caseId>-expect-<n>-FAIL.png
  trace/<caseId>.zip
```

headless / 不录屏（默认）：只留失败截图、`<caseId>-final.png`、`trace/*.zip` 和 `result.json`；**不建 `deliverable/`、`subtitles/`，不产 mp4/srt**。`result.json` 的 `record` 字段写的是最终生效值。

## 录屏呈现

画面由 Playwright 原生 screencast + 执行器自绘的字幕组成，用例只负责给 `caption` —— **呈现层不参与判据**：

- **录制**：`page.screencast.start({ path, size: viewport, fps: 30, quality: 100 })`（抓帧 JPEG 质量拉满），`stop()` 落盘 WebM 再转 h264（1920×1080 / 30fps / `-preset slow -crf 18` / `yuv420p` + `bt709` 标记）。**不再用 `contextOptions.recordVideo`**，避免双路抓帧。`tracing` 保留，但 screencast 必须**先于** tracing 启动：tracing 自己也是 screencast client，谁先挂上谁决定抓帧尺寸（它先挂就按默认 800×450 抓，画面会被塞进左上角）。
- **章节卡**：每条用例第一次 `goto` 成功后 `showChapter(title, { description: '<case.id> · <case.ac>', duration: 1200 })` —— 居中卡片 + 背景模糊；失败用例同样有。卡片期间**不叠底部字幕**，字幕等卡片退场后再上（`showChapter` 会一直阻塞到淡出结束，调用方不要再补 sleep）。
- **指针动作**：`click/fill/type/select/check/uncheck/press/hover/upload` 的光标与目标框由原生 `showActions({ cursor: 'pointer', duration: 800, style: { point, highlight, title: 'display:none' } })` 画 —— 平滑移动的光标 + 2px 蓝描边目标框，**不再自绘**（否则同一个目标会出现两个框）。动作标题关掉，文案只走字幕。
- **非指针动作**：`waitFor`（出现后高亮 300ms）、`scrollTo`（**先滚完再取框**，高亮滚动后的位置）用注入式覆盖层 `__webTesterHighlight` 自绘；`goto/reload/goBack` 不高亮，只清上一处；`screenshot` 前先清，交付截图不带高亮。
- **字幕**：底部居中的半透明字幕条（`rgba(17,24,39,.82)` 底、白字 18px、圆角 6px），文字**就是 `caption` 原文**：没有 `🤖`、没有 `[Agent 操作]:` 之类前缀，也没有任何图标；SRT 同样只写 caption。
- **步骤卡**（`hud: card|both`）：默认右下 `bottom:24px; right:24px`，`hudPosition` 可改到 `bottom-center`（水平居中贴底，`left:50%; transform:translateX(-50%)`）、`bottom-left`、`top-center`（水平居中贴顶）。磨砂卡片（`rgba(15,23,42,.78)` + `blur(12px)`、左侧 4px `#38bdf8` 描边、默认 `max-width:460px`，`bottom-center` 放宽到 `min(720px, 72vw)`）。第一行 `STEP 01`（两位补零，`#38bdf8`）＋ 右上角 `meta.name`（没写就不显示），第二行 `title`，第三行 `detail`。**复用同一个节点只改 textContent，换步不闪烁**；导航后由 addInitScript 重建。`hud: card` 不显示底部字幕条；`hud: both` 两者都在：卡片在底部左右两侧时字幕上限自动收窄到卡片左侧，`bottom-center` 时字幕自动上移到卡片上方（间距 `12px`，用 ResizeObserver 跟卡片实时高度同步，不写死像素）；**SRT 始终生成**。
- **焦点**（`focus`）：`ring` 是 2px `#38bdf8` 描边 + 四角标记；`spotlight` 把同一个框做成「目标透明 + 框外 `box-shadow: 0 0 0 9999px rgba(0,0,0,dim)`」，淡入 150ms，元素不可见/框为空时**不压暗**。spotlight 与原生光标/目标框共存（指针动作两套一起出现），章节卡期间不显示；动作阶段结束后（进断言）自动撤掉，失败画面保持原样可读。
- **打码**（`mask` / `maskPasswords`）：往每个文档注入一段 CSS（`filter: blur(5px) !important`），只影响画面，**不改元素值、不影响断言**；仅在录屏模式注入。
- **失败**：红色提示，文案统一 `失败：<原因>`，`hud: card` 时是红色左边框的卡片，同样不带图标。
- **节奏**：原生装饰的 `duration` 是**串行等待时间**（每个带 point/box 的输入动作会先展示装饰 800ms 再真正执行），所以单条用例会因此变长；调 `SCREENCAST_ACTION_MS / SCREENCAST_CHAPTER_MS / SCREENCAST_CURSOR_MS` 就是在「好看」和「时长」之间换挡。
- `--no-record` 完全不启动 screencast、不调 `showActions/showChapter`、不注入自绘覆盖层与打码 CSS —— 动作路径零额外开销。
- **章节卡 / 光标 / 目标框 / 卡片 / 压暗 / 打码都只属于演示层，不参与断言，不影响 PASS/FAIL。**

卡片位置示例（水平居中贴底，字幕自动上移到卡片上方）：

```yaml
meta:
  name: 运维问答演示
  presentation: true
  hud: both
  hudPosition: bottom-center   # bottom-right(默认) | bottom-center | bottom-left | top-center
  focus: spotlight
  record: true
```

## 时间压缩（加速）

录屏里最长的往往是**等**：等模型流式输出、等接口返回、等页面加载完。这些时间在画面上几乎不变，看的人却在干等。所以执行器在**转码期**做时间压缩（录制仍按真实时间跑，断言、截图、trace 一律不受影响）：

- **按实测阻塞耗时压，动作段保持 1x**：执行期给每个阻塞边界埋点（`goto` 加载 / `waitFor` / `waitForTimeout` / `reload` / `goBack` / 每条断言轮询），记下它**真实等了多久**。任何一个 `kind: "wait"` 且时长 ≥ `--wait-min`（默认 2000ms）的段，先按 `--wait-hold`（默认 1500ms）正常速度放，再按 `--wait-speed`（`--present` 默认 6x）加速；剩余不足 500ms 不拆。动作段（click / fill / type / hover…）与截图落盘（`kind: "overhead"`）一律 1x。
- **与测试类型无关**：判据是「这段实际阻塞了多久」，不看动作名 —— 模型流式输出、慢接口、慢首屏（`goto` 等 load）、慢断言（`expect` 轮询）、RPA 等待，全都按同一套规则压；反过来，`waitForTimeout` 只等 300ms 也不会被压。
- **`--present` 默认 `--wait-speed 6`**，`--record` 回归视频默认 1x；命令行显式传参优先。`--speed <n>` 是全局倍速，与等待段/步级倍速**相乘**。
- **按步骤手动指定**：用例里给某一步写 `speed: 3`，那一步整段按 3x（适合「这一步本来就要看慢一点/快一点」）。优先级：步级 `speed` > 等待段规则 > 1x；步级与等待段重叠时以步级为准（**不重复相乘**）。
- **一次编码出片**：按时间轴拼出 `trim + setpts=(PTS-STARTPTS)/speed + concat` 的 `-filter_complex`，只编码一次（不先切片、不做二次转码）。相邻同倍速段会合并，避免碎片。
- **字幕与 result.json 的时间轴都是成片时间**：SRT 的 cue 起止都做了重映射并裁到成片时长内（不越界、不重叠，每条至少 300ms）；`steps[].videoOffsetMs` 是映射后的值（抽帧取证直接用它），原始墙钟留在 `steps[].wallOffsetMs`。
- **对账**：`result.json` 顶层与每条用例都有 `speed: { global, waitSpeed, waitHoldMs, waitMinMs, applied }`，用例上还有 `source_duration_ms`（原始真实时长）和 `spans`（每条阻塞埋点 `{ kind, label, startMs, endMs }`，绝对 ms，最多 500 条、超出先丢 `overhead`）。**核对「哪几段被压了」就看 `spans` 里 `kind: "wait"` 且 `endMs - startMs ≥ waitMinMs` 的条目**；整条用例没有任何这样的段就保持 1x，不报错。`applied: false` = 这支成片是真实时间轴。
- **要证据就关掉加速**：`--no-speed`（= `--speed 1 --wait-speed 1`）。需要「视频时长 = 墙钟时长」的场合（耗时取证、卡顿复盘）必须用它。
- **失败降级**：分段/滤镜出错时打警告并退回 1x 简单转码（字幕同时退回真实时间轴），**绝不出现「没有 mp4」**。
- **加速只影响观看时长**，不影响任何断言、截图、trace 证据：判据在 `result.json`，逐步截图与 trace 都是真实动作帧。

```bash
node run.mjs --cases cases.yaml --present                      # 演示：≥2s 的实测阻塞 6x
node run.mjs --cases cases.yaml --present --wait-speed 10      # 更激进
node run.mjs --cases cases.yaml --present --wait-min 800       # 连 1s 的慢接口也压
node run.mjs --cases cases.yaml --record --no-speed            # 回归/证据：真实时间轴
node run.mjs --cases cases.yaml --present --crf 16 --preset slower   # 画质再高一档（更慢更大）
```

## 演示别人开发的网站

对外汇报场景（站点不归我们改，只做只读演示 + 录屏）按这套走：

1. **优先只读流程**：`goto → waitFor → scrollTo → click 展开/切换 → hover`。能不提交就不提交；确需提交时明确写进 preconditions。
2. **登录 / 2FA / 验证码**：人工过一次，存登录态复用，不要在用例里存密码、也不要试着绕验证码：
   ```bash
   node run.mjs --cases cases.yaml --save-storage ./state.json   # 有头打开 baseUrl，人工登录后按 Enter
   node run.mjs --cases cases.yaml --present                      # 演示+录屏；meta.storageState: ./state.json（相对用例目录）
   ```
3. **敏感信息**：`mask: [".user-email", ".token"]` 把要打码的选择器列出来；密码框靠 `maskPasswords`（默认开）。
4. **定位**：只用 `role / text / testid / label / placeholder`。**禁止绝对 XPath、禁止坐标点击**——别人的站点改一次 DOM 就全废。iframe 内元素暂不支持覆盖层（卡片/压暗/打码都进不去 iframe），演示 iframe 内容就先别指望 HUD。
5. **站点改版 → 重写用例，不改执行器**：`CASE-INVALID` 或缺元素是「用例与站点脱节」的信号，修的是 YAML（必要时重新冻结），不是放宽判据。
6. **演示模式开关**：`meta.presentation: true` 或 `--present`（步骤卡 + spotlight + 打码），`hud` / `focus` 按现场口味微调；正式验收跑还是用默认字幕模式。

## 环境与依赖

- 依赖：`playwright-core` + `yaml`（`npm install` 已装）。**用系统 Chrome，不下载浏览器。**
- 录屏：screencast 编码同样要 Playwright 自带的 ffmpeg（`ms-playwright/ffmpeg-<rev>`）。本技能**不下载**：如果系统缓存里没有对应版本，执行器会自动在 `.pw-browsers/ffmpeg-<rev>/ffmpeg-mac` 软链到系统 `ffmpeg`（brew 安装的），再把 `PLAYWRIGHT_BROWSERS_PATH` 指过去。系统也没有 ffmpeg 时录屏关闭并给出警告。
- Chrome 启动失败时自动回退 `executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`；也可以用 `PW_CHANNEL` 指定其他 channel。

## 非 Web 场景（结构完全复用）

用例结构（id/ac/type/title/preconditions/steps/expect）**原样复用**，只换执行层：HTTP runner（断言状态码/JSON 字段）、CLI runner（退出码/stdout 正则）、DB runner（查询结果计数）、RPA runner（图像/控件动作）。这些场景**不需要 HUD、录屏、SRT**，除非要给人演示——那就保留 `record` 与 caption，执行层换成截图/RPA 回放。

## 反模式

- ❌ 用例没有 `expect`（门禁会拦，别绕）
- ❌ 空泛断言：「验证功能正常」「页面无报错」
- ❌ 用**实际输出**反填期望值（同源自比，永远 PASS）
- ❌ 写了 `expect` 但执行器不认的字段（如自定义 `assert:` / `should:`）—— 字段必须在上面的表里
- ❌ 业务代码里手写 `step('...')` 当字幕
- ❌ 用例没冻结就边跑边改判据
- ❌ 每跑一次就问用户「要不要录」——按场景表自动判定，默认不录
- ❌ 任务里没有「录屏/视频/演示/汇报/交付」意图却默认出视频（浪费时长与磁盘）
- ❌ 演示别人的站点用绝对 XPath / 坐标点击，或者把账号密码写进用例（要用 `--save-storage` + `mask`）
- ❌ 把 headless 跑通当成「录屏交付也 OK」（画面/HUD 必须真看一眼）
