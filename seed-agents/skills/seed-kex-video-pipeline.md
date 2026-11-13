---
name: kex-video-pipeline
description: kex-labs-video 视频制作骨架（六阶段 A→F）的开发、排障与验收 SOP。当任务涉及 ComfyUI/SDXL/LTXV、Ollama VLM、镜头切分、关键帧重绘、I2V、state.json 断点续跑，或项目 `~/kex/projects/kex-labs-video` 时触发。Not for：通用 Web/后端开发、非本项目的视频剪辑、纯 UI 改版。
---

# kex 视频制作流水线（域 SOP）

## 0. 环境（先确认，别猜）
- 算力机：`ssh studio-ts`（tailnet `100.92.106.101`）。**MacBook 不跑模型、不 clone 仓库、不建 venv。**
- 项目根：`~/kex/projects/kex-labs-video`（Studio）。
- 服务：ComfyUI `http://127.0.0.1:8188`、Ollama `http://127.0.0.1:11434`；**不启停、不改配置**。
- 远端：NAS Gitea `http://100.123.73.123:3000/gitadmin/kex-labs-video.git`（token 在 Studio `~/.config/gitea/token`，600，**不回显**）。
- 设计真相源（MacBook）：`~/Documents/master-dev/myself/kex_labs_ai_agent_v4_2.md`；契约：`~/Documents/master-dev/myself/.opencode/state/T-VID-*-contract.md`。

## 1. 六阶段（phase-major，绝不逐镜交替）
| 阶段 | 工具 | 模型 / 说明 |
|---|---|---|
| A | `probe_video` / `split_shots` / `extract_frames` | 无重型模型 |
| B | `describe_frames` | Qwen2-VL（Ollama，`keep_alive=0`） |
| B2 | `select_profile` | 纯函数：semantics → profile/look/bgm_tone |
| C | `render_frames` | SDXL（ComfyUI img2img） |
| D | `generate_clips` | LTXV I2V，3~5s/段，3×49f 链式 |
| E | `interpolate` → `upscale` → `grade_color` | RIFE / Real-ESRGAN |
| F | `synthesize_audio` / `assemble` / `archive` | 音画 + 封装 |

**阶段串行**：一阶段处理全部镜头后再进下一阶段；阶段间必须卸载上一模型并确认内存。

## 2. 工具硬契约（沿用 M1）
1. `ToolResult = {status: ok|failed|blocked|needs_human, output, error, cost}`；非 ok 必须带 `error`。
2. 幂等键 `(tool, args_hash, input_hash)`；命中直接返回，不产生重复副作用。
3. `state.json` 原子写（`tmp + os.replace`）；字段至少 `job_id/stage/shots/frames/semantics/profile/updated_at`。
4. 断点续跑：同 `--job` 跳过已完成 stage；仅 `--force` 重算。
5. 重试 ≤2 次、指数退避；最终失败写 `failed`，不吞异常。
6. 确定性：同素材两次运行，`typology` / `profile.name` 必须一致；seed 与 workflow hash 入库。

## 3. 内存守卫（C/D 必做）
- 进 C/D 前：Ollama `keep_alive=0` + ComfyUI `/free`；可用内存 > 模型体积 + **12GB** 再跑。
- 读 `vm_stat` 留前后证据；Ollama `/api/ps` 必须为空。
- 阶段失败可整段重跑；已完成阶段的产物 mtime 不变。

## 4. 执行纪律
- **命令合批 + 输出截断**：`| head -n 40` 或落 `/tmp/*.log`，禁止整段日志进上下文。
- **长任务后台化**：预计 >30s 的渲染/测试用 `nohup … > /tmp/<name>.log 2>&1 &`，分次读日志。
- **只写项目目录与 `/tmp`**；不碰 `.venv/`、模型权重、密钥；`.git` 不放产物。
- **提交粒度**：一个工具 / 一个修复 = 一次 commit；测试绿了才提交；完成即 push，不攒批。
- **测试后自清理**：删 `/tmp` 测试目录、临时素材、验收自建 job 产物；只留 `acceptance/` 或 `state` 所需证据。

## 5. 验收口径
- `pytest -q` 全绿（不放宽断言）；`bash run.sh --job <id>` 可复跑。
- 必须给：state/report 片段、产物 `ls -lh`、幂等 mtime、续跑日志、内存前后、commit hash + push 校验。
- L2 改动（跨模块/契约/性能）另派 `acceptance-tester` 黑盒验收，FAIL 必须 0。

## 6. 常见排障
| 现象 | 处理 |
|---|---|
| curl 访问 `100.64/10` 失败 / 503 | 被 QuickQ 系统代理或 shell `http_proxy` 拦；用 `curl --noproxy '*'` 对照，补 bypass/no_proxy |
| ComfyUI `/free` 返回 200 空 body | 按空 body 处理（`{}`），不要当 JSON 解析失败 |
| ComfyUI 连不上 | 先 `curl --noproxy '*' http://127.0.0.1:8188/system_stats`；未起则报 `blocked`，别改配置 |
| 模型名找不到 | 查 `/object_info/CheckpointLoaderSimple` 的 `ckpt_name` 列表，别猜 |
| MPS OOM | 确认前一阶段模型已卸载；降分辨率/换小模型前先记证据，别静默降级 |
| 输出不确定 | 记录 `bitwise_deterministic`；seed + workflow sha 必须可复现参数 |

## 7. 输入 / 输出契约
- 输入：项目内 `jobs/<job>/` 或 NAS 素材路径；禁止把大素材拷进 git。
- 输出：`state/<job>.json`、`reports/<job>.json`、`jobs/<job>/{frames,rendered,clips}/`。
- 报告必须含：每步耗时、产物路径、seed、workflow_sha256、内存前后、`failed[]`、`unverified[]`。
