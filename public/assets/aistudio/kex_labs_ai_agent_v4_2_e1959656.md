# Kex Labs｜纯本地 AI 视频拆帧重构与 Agent 自动化平台 · V4.2
## 硬件锁定 · Agent 全编排 · 三端分工 · 内网服务栈 · I2V 交付 · 记忆体 · 归档整理版

> 本版基于 V3.0 修订。架构方向保留，但把「估算值」换成「已确认的硬件事实」，
> 并把 Phase 1 从「搭基础设施」改成「跑通一条链路」。
>
> **V4.2 修订（2026-11-02）**：2TB M.2 定为独立应用池（Basic / ext4），**不启用 SSD 缓存**；
> 同步重估 NAS 16GB 内存预算与升级触发条件。

---

## 版本变更（V3.0 → V4.2，含 2026-11-02 修订）

| # | 改动 | 原因 |
|---|---|---|
| 1 | 硬件清单全部锁定具体型号与参数 | 已完成选型，不再有「假设的硬件」 |
| 2 | 删除「Mac 外置雷雳 NVMe」必买项 | 实际占用约 170GB，1TB 内置够用；外置 TB4 2.8GB/s 比内置 5~7GB/s 更慢，仅作观察项 |
| 3 | 删除「10G 交换机」必买项 | NAS 有 1×10GbE，与 Mac 直连即可，零成本 |
| 4 | Phase 1 删除 Celery / NFS 挂载 | Celery 管不到 ComfyUI/Ollama 的内存；**Redis 于 V3.5 恢复为必需组件，见第十一章** |
| 5 | 补「成片形态」这一决策缺口 | 砍掉视频生成后，原方案没说明如何产出连续视频 |
| 6 | 补可量化验收判据、数据契约、离线镜像备份 | V3.0 只有一条 <15 分钟指标，无法验收 |
| 7 | 新增第九章「Master 编排层接入」 | 把 opencode 治理架构与视频平台的分工写死，防止 Agent 越界做调度 |
| 8 | 明确「生产运行 ≠ Agent 会话」 | 生产走 launchd/cron，会话只做开发、验收、发起批次 |
| 9 | **重写 C3**：由「严禁 LLM 做调度」改为「决策与执行分离」 | 用户最终目标是用 Agent 做完整编排，原表述直接冲突 |
| 10 | **重写第九章**：Master 编排层 → Agent 全编排架构（四层） | 补齐 orchestrator / tools / 旁路 / 失控点防线 |
| 11 | 明确实施顺序：先工具后 Agent | 把 Agent 放在不稳定脚本之上会稳定地做错事 |
| 12 | 新增第十章「三端分工与远程接入」 | MacBook M1 只做客户端，需在局域网/外网访问 Studio 与 NAS |
| 13 | **恢复 Redis 为必需组件**，新增第十一章「内网基础服务栈」 | 用户明确需要 Redis（自身工作也要用）；文档缺私有 Git 与内网服务层 |
| 14 | **成片形态定为 C（图生视频）** | 用户要求能真实交付的产品；A 只是剪辑，B 会崩 |
| 15 | 流水线改为 **phase-major 六阶段** | 引入 I2V 后三个模型无法共存于 48GB，必须按阶段独占内存 |
| 16 | 新增 **Phase 0.5 I2V 可行性闸门** | C 能否在这台机器跑通是最大未知，先验证再排产 |
| 17 | 新增一致性策略与质量门槛 | 「能交付」与「能跑通」的差别就在这几条 |
| 18 | 新增第十二章「记忆体服务接入」 | 自研 agent-memory 需从 M1 迁出，改 NAS 跑服务 / Studio 跑模型 |
| 19 | 明确 reranker「只有一份」的三条纪律（V4.2 修订补第 4 条：容器总量封顶） | prefork × 多 worker 会让 2GB 的 reranker 变成 10GB |
| 20 | 给出 NAS 16GB 的完整分配与升级触发条件 | 回答「加了 Docker 会不会拖慢 NAS 原生功能」 |
| 21 | 新增 6.6「产物归档与本地留存」 | 输出全部落 NAS，Mac / Studio 只保留热数据与 7 天缓存 |
| 22 | 新增第十三章「文件整理自动化」 | 代码与日常文件由 Agent 主动整理，但必须分三档权限 |
| 23 | 7.2 改为 L0~L3 测试阶梯 | MPS 上的 I2V 必须先验最小可用子集 |
| 24 | 9.4 增加分队列 / 心跳 / 单项锁 | 长任务 ACK 超时会导致同一镜头被重复渲染 |
| 25 | 9.9 改用 flock 替代 PID 探测 | PID 复用会让僵尸锁永远不放 |
| 26 | **2TB M.2 定为独立应用池，明确不做 SSD 缓存** | 同一块 M.2 只能二选一；用「应用池 + 冷归档池」分层替代缓存这层间接机制，减少变量、提高可预测性 |
| 27 | **重估 NAS 16GB 内存**：分稳态 / 峰值 / Phase 3 三档，并给出取证口径 | 原「16GB 够用」只有一张账面表，缺峰值叠加与升级判据 |
| 28 | **新增 4.5 调色链路 + `grade_color` 工具**（2026-11-04） | I2V 逐段生成必然段间色偏；原方案只有「统一 LUT」一句，缺位置/工具/判据 |
| 29 | **新增 4.6 语义接地 → Profile 挂载（B2 阶段）**（2026-11-04） | 原流程只有 VLM 打标，缺「理解结果如何决定风格/调色/音乐」的确定性映射与兜底 |
| 30 | **新增 4.7 活人感工程化 + 9.15 NAS Gitea 提交纪律**（2026-11-04） | 用户明确：成片要像真人拍的；代码要及时提交到 NAS Gitea |

---
## 〇、最终目标与验收（2026-11-04 追加）

> 本章是全局锚点：后文所有阶段、选型、排产都以「能不能通向本章终点」为准。只追加，不改既有章节。

### 0.1 北极星

> 任意一段实拍素材或一句创意文案 → 进 Mac Studio → **无人值守**产出一条 **15~60 秒、1080p / 30fps、音画同步、风格可控**的成片；全程纯本地、可复现、可续跑，失败不丢进度，产物自动归档 NAS。MacBook 只发指令、只看结果。

### 0.2 终点交付物（5 个，缺一不算达成）

| # | 交付物 | 形态 |
|---|---|---|
| 1 | `orchestrator.py` + L2 工具闭集（14 个） | launchd 常驻；LLM 不可用/超时自动走 `default_policy()`（§9.4） |
| 2 | ComfyUI workflow 库 | SDXL 关键帧重绘 + LTXV I2V（3~5 s/段）+ 3×49f 链式拼接 |
| 3 | 4 套 Director Profile | 广告商业 / 风景大片 / 人物 Vlog / 宣传纪实（prompt + LUT + 配乐基调模板）；附「语义 → Profile」映射表与兜底规则（§4.6） |
| 4 | 两条样片 + 验收报告 | 30 s（5~8 镜）、60 s（10~15 镜），含音轨，附人工抽检记录 |
| 5 | 批量 5 条无人值守记录 | 失败可续跑、自动出报告 |

> **角色 ≠ 进程**：导演 / 编剧 / 摄影 / 后期 / 音频 / 调色六个角色是 **L3 单 Orchestrator 下的 prompt + 技能包（profile）**，不是六个独立服务。理由：64 GB 下多进程只会放大内存与故障域，且违反 C3「决策与执行分离」。

### 0.3 能做到 / 做不到（提前对齐，避免反复）

| 能做到 | 做不到（不承诺） |
|---|---|
| 4 类母题模板自动匹配（广告 / 风景 / Vlog / 纪实） | 「全品类任意输入通吃」 |
| 3~5 s/镜头、5~20 镜头分段拼接 | 单条 >5 s 不漂移（实测第 **32 帧**跌破 SSIM 0.90） |
| 1080p / 30fps + 音轨 + 自动归档 | 4K / 3 分钟以上长片 |
| 一致性抽检偏差 ≤ 2/10 | 真正的「大师级审美理解」，落地只能是模板化风格 |
| 本地 Qwen2-VL 理解 + 本地生成（零云端） | 纯本地口播 lip-sync（Phase 4 可选，未验证） |
| 决策层 Agent + 确定性执行（不翻车） | 失败时云端 API 兜底（C1 禁止） |
| 「活人感」工程化（微抖 / 颗粒 / 非匀速 / 环境声） | 100% 骗过专业观众 |

### 0.4 达成判据

| 阶段 | 交付 | 通过标准 |
|---|---|---|
| Phase 1 | 六阶段串成一条命令，跑完 1 个镜头 | 全链路可续跑；`state.json` 完整；阶段间内存正确释放 |
| Phase 2 | 一条 30 s 成片（5~8 镜） | 端到端 **≤ 60 分钟**；一致性抽检偏差 **≤ 2/10**；色彩 p95 ΔE2000 **≤ 6**（§4.5） |
| Phase 3 | 一条 60 s 成片（10~15 镜） | 端到端 **≤ 2 小时**；音画同步；可交付；色彩 p95 ΔE2000 **≤ 6**（§4.5） |
| Phase 4 | 批量 5 条无人值守 | 失败可续跑；自动报告；口播 lip-sync（可选） |

> 活人感按 §4.7 验收：10 段盲测「像真人拍的」≥ 7/10。

### 0.5 当前差距（截至 2026-11-04）

| 项 | 状态 |
|---|---|
| Phase 0 冒烟 4/4、Phase 0.5 L0~L3、真 I2V（首帧 SSIM 0.970）、3×49f 链式（交界 0.979/0.985） | ✅ 已过（Go） |
| Phase 1：六阶段一条命令 + 断点续跑 | ❌ 未开始 |
| 音频链：TTS / ASR / 本地 BGM 选型与实测 | ❌ 未选型（MPS 上的内存/耗时未知） |
| 调色链路：`grade_color` + 4 套 LUT | ❌ 未实现（本轮补设计，见 §4.5） |
| 语义 → Profile 挂载（B2） | ❌ 未实现（本轮补设计，见 §4.6） |
| 活人感工程化（§4.7 的 5 维参数与质检） | ❌ 未实现（本轮补设计） |
| L3/L2 编排、Redis Stream 队列、单项锁 | ❌ 未实现 |
| Studio 守护化（LaunchDaemon + 内存守卫） | ❌ 现为 nohup 手工起，无人值守会死 |
| 记忆体迁 NAS | 🟡 评估已出（`acceptance/AGENT-MEMORY-ASSESSMENT-2026-11-04.md`），NAS 实测待补 |
| 许可证复核（FLUX dev / Ultralytics / ComfyUI） | ❌ 商用交付前必做（C5） |

### 0.6 下一步顺序（推荐）

1. **Phase 1 单镜头全链路**：六阶段串成一条命令，音频先占位，先打通 `state.json` 续跑。
2. **音频 spike（并行）**：TTS / ASR / Stable Audio Open 各跑一次，只测 MPS 可用性 + 内存峰值 + 耗时，再定选型。
3. **Studio 守护化**：LaunchDaemon + 内存守卫（读 `vm_stat` 达标才加载模型）；否则后续全是手工跑。

---

## 一、目标与硬约束

### 1.1 业务目标

双轨短视频生产：

1. **实拍处理链路**：商家实拍视频 → 镜头切分 → 关键帧 → 本地 VLM 理解 → Prompt → 本地扩散模型重构 → 合成成片。
2. **AIGC 链路**：Prompt → 生图 → 图生视频 → 音频/字幕（ASR + TTS）。

### 1.2 五条硬约束

**C1 · 全本地**
所有推理与生成在 Mac Studio 上闭环，不调用云端 API。

**C2 · 64GB 内存生存线**
macOS 默认 `iogpu.wired_limit_mb` ≈ 内存的 75%，**64GB 机器 Metal 实际可用约 48GB**，不是 64GB。

- **默认档**：SDXL（≈8GB）+ Qwen2-VL-7B Q4（≈6GB）→ 可同时常驻
- **高质档**：FLUX.1 schnell fp16（≈33GB，含 T5）→ **必须卸载 Ollama** 后才能跑
- 禁止并发两个重型模型

**C3 · 决策与执行分离（Agent 全编排的前提）**

- **决策层（非确定性）**：Agent 决定「下一步做什么、用什么参数、质量够不够、要不要重跑」。这是允许的，也是本方案的最终目标。
- **执行层（确定性）**：锁、重试、超时、幂等、状态持久化、断点续跑、并发控制，**全部由代码实现，不由 Agent 承担**。
- **禁止项**：Agent 直接操作 ComfyUI/Ollama 内部队列、直接改业务文件、直接开进程。Agent 只能调用 L2 暴露的闭集工具。
- **旁路**：LLM 不可用或超时 → 自动回退 `default_policy()`，任务必须继续跑完。

一句话：**Agent 决定做什么，代码保证做对。**

**C4 · 热数据本地**
代码、venv、热模型、帧缓冲全部落 Mac 本地 SSD。NAS 只做冷存储 + 容器宿主。
**禁止**把 SQLite / Qdrant 数据文件、Python venv、Frame_Buffer 放在 NFS/SMB 上。

**C5 · 商用前复核许可证**
本期不阻塞开发，但对外交付前必须复核：FLUX.1 [dev] 非商用、Ultralytics AGPL-3.0 传染、ComfyUI GPL-3.0。
当前选型已规避主要风险（Schnell / SDXL / YOLOX），上线前补一份许可证清单即可。

---

## 二、硬件清单（已锁定）

### 2.1 BOM

| 设备 | 规格 | 用途 | 状态 |
|---|---|---|---|
| **Mac Studio** M5 Max | 18 核 CPU + 40 核 GPU / **64GB 统一内存** / **1TB SSD** / 内置 10GbE | 全部 AI 算力 | ✅ 已定 |
| **绿联 DXP4800 Pro** | Intel i3-1315U / 16GB DDR5 单条（空一槽，上限 96GB，**无 ECC**）/ 128GB 系统 SSD / 4× SATA 6Gbps / **2× M.2 NVMe 2280 PCIe 4.0 ×4** / **1× 10GbE + 1× 2.5GbE** / 无 PCIe 槽 / **不支持热插拔** / 19V 7.9A | 存储 + 容器宿主 | ✅ 已定 |
| **东芝 N300 8TB ×2** | 7200rpm / 512MB / CMR / SATA | RAID1 → **8TB 可用** | ✅ 已定 |
| **七彩虹 CF600 2TB NVMe** | 2280 / 读写约 3.4GB/s、2.4GB/s / 640TBW | **独立应用池**（Docker / PostgreSQL / Redis / Qdrant / Gitea），**不做 SSD 缓存** | ✅ 已定，待确认单面 |
| **UPS** | 600VA / 360W / **必须带 USB 通讯** | NAS + 光猫 + 路由 | ⚠️ 型号待定 |
| ~~10G 交换机~~ | — | — | ⏸ 不买，直连 |
| ~~Mac 外置雷雳盘~~ | — | — | ⏸ 观察项 |

### 2.2 网络拓扑（零成本方案）

```
Mac Studio 10GbE ──直连── NAS 10GbE
  192.168.100.1/24      192.168.100.2/24（不配网关）
                              │
                        NAS 2.5GbE ──→ 路由器（DHCP，接入家庭网络）
                                     │
                           手机 / 其他设备访问 NAS

Mac 上网走 Wi-Fi
```

- 一次性配置：两端万兆口手动静态 IP，**NAS 端不设网关**（避免双默认路由）
- macOS「系统设置 → 网络 → 服务顺序」把 Wi-Fi 放前面
- 实测预期：SMB 读 800~1100MB/s，写 700~950MB/s
- **暂不买交换机**；若将来嫌 Wi-Fi 上网不便，再补 10G 交换机

### 2.3 存储分层

| 位置 | 目录 / 用途 | 容量预算 | 策略 |
|---|---|---|---|
| **Mac 内置 1TB** | macOS / venv / 代码 / ComfyUI 节点 | ~90GB | — |
| **Mac 内置 1TB** | 热模型（SDXL / FLUX schnell / Qwen2-VL-7B / LTX-2B / SVD） | ~110GB | NAS 为冷库，仅更新时同步 |
| **Mac 内置 1TB** | Frame_Buffer | ~20GB | 任务完成即打包归档到 NAS，随后清空 |
| **Mac 内置 1TB** | 交付缓存（最近 7 天） | ~100GB | 超出自动清理，见 6.6 |
| **NAS M.2 CF600 2TB** | Docker 镜像与卷 / PostgreSQL / Redis / Qdrant / Gitea | ≤150GB | **ext4**，Basic 独立池，**禁止做 SSD 缓存** |
| **NAS RAID1 8TB** | 原始素材 / 成片 / **Frame_Buffer 归档** / 镜像与配置备份 / 冷备 | 8TB | 只做顺序大文件，回收站 + Btrfs 周快照 |

> 剩余容量：Mac 约 800GB，NAS 8TB，够 Phase 1~2 全量使用。

### 2.3.1 存储决策：独立应用池 + 冷归档池，不做 SSD 缓存

**结论：2TB M.2 直接创建为独立存储池（Basic / ext4），不启用 SSD 缓存。**

理由：

1. **收益错配**：SSD 缓存的收益集中在「小文件随机 I/O 的间接加速」，且完全依赖缓存命中率。命中率高才有收益；命中率低时，只是多了一层需要维护、需要观测的机制。
2. **持续成本**：缓存要常驻元数据、承接回写，内存占用随写入量波动。在 16GB 内存的 DXP4800 Pro 上，这是一个**动态、无法精确预算**的变量。
3. **确定性优先**：把随机 I/O 敏感的服务（Docker 容器、PostgreSQL、Redis、Qdrant、Gitea）直接放 SSD，延迟由介质决定，不由缓存算法决定 —— 不依赖命中率，也不额外挤占内存。
4. **HDD 不需要缓存**：8TB RAID1 承担原始素材、成片、Frame_Buffer 归档、冷备份，都是顺序大文件读写，顺序吞吐本来就够；缓存对它帮助有限。

因此，「不做缓存」不是功能缺失，而是用**分层替代一层间接机制**：少一个算法、少一份内存波动、少一个故障面。

| 池 | 介质 | 文件系统 | 承载 | 明确不做 |
|---|---|---|---|---|
| **应用池** | 2TB M.2 NVMe（Basic，单盘） | ext4 | Docker 镜像与卷、PostgreSQL、Redis、Qdrant、Gitea、其余常驻服务 | 不做 SSD 缓存；不放素材；不存唯一副本 |
| **冷归档池** | 8TB HDD RAID1 | Btrfs | 原始素材、成片、Frame_Buffer 归档、交付包、备份、快照 | 不跑容器；不跑数据库 |

> **同一块 M.2 只能二选一**：做缓存就不能做存储池。选存储池，是把「加速」从概率问题变成确定性问题。
>
> **代价与补偿**：SSD 是单盘 Basic、无冗余。补偿方式是「SSD 上不放唯一副本」——PostgreSQL / Qdrant 每日 dump + snapshot 到 RAID1，Gitea 每日 `gitea dump` + 每周 restic 到外置冷备，镜像 `docker save` 到 RAID1。SSD 挂了按 6.2 重建，RPO ≤ 24h。

### 2.4 硬件能力边界（明确不能做）

| 不能做 | 原因 |
|---|---|
| NAS 外接 GPU / eGPU | 无 PCIe 槽；只有 USB-C 3.2 Gen2（不承载 PCIe）；UGOS 无 GPU 直通 |
| RAID1 热插拔换盘 | 官方明确不支持，换盘必须断电 |
| 升级内存/硬盘（Mac） | Mac Studio 64GB / 1TB 均为焊死 |
| 单机跑 Wan2.1-I2V-14B 视频生成 | 64GB 下 fp16 需 40GB+，与其它模型无法共存；I2V 改用 2B / 5B 档 |
| 用满 M.2 的 PCIe 4.0 带宽 | 理论 64GT/s，实际受 NAS 平台限制，Docker 场景无感 |

---

## 三、软件底座

### 3.1 组件与职责

| 层级 | 选型 | 许可证 | 职责 |
|---|---|---|---|
| 生成引擎 | **ComfyUI**（Headless API） | GPL-3.0 | 出图（SDXL / FLUX）与出视频（LTX / SVD） |
| 镜头切分 | **PySceneDetect** | BSD-3 | ContentDetector / AdaptiveDetector 做镜头边界 |
| 视频读写 | ffmpeg + OpenCV | LGPL / Apache-2.0 | 解码、抽帧、拼接、封装 |
| 目标检测/分割 | **YOLOX / RT-DETR（ONNX）** | Apache-2.0 | 主体裁剪与一致性参考，Phase 2 起用 |
| 多模态理解 | **Ollama + Qwen2-VL-7B Q4** | Apache-2.0 | 关键帧语义 → 结构化 JSON |
| **图生视频（主力）** | **LTX-Video 2B（I2V）** | 待商用复核 | 关键帧 → 3~5 秒片段，768×512 @24fps |
| **图生视频（备选）** | **SVD / SVD-XT** | Stability 社区许可（待复核） | 576×1024 @6~8fps，竖屏 |
| **图生视频（质量上限）** | **Wan2.2-TI2V-5B** | Apache-2.0 | 720p@24fps，MPS 上需实测 |
| **帧插值** | **RIFE（rife-ncnn / ComfyUI 节点）** | MIT | 6~24fps → 30fps |
| **超分** | **Real-ESRGAN / 4x-UltraSharp** | BSD-3 | 720p → 1080p |
| 语音字幕 | **Faster-Whisper + Kokoro-82M** | MIT / Apache-2.0 | ASR 字幕 + TTS 旁白 |
| 口型（可选） | LatentSync / Wav2Lip | 待复核 | 人物口播对齐，Phase 4 |
| 向量库 | **Qdrant** | Apache-2.0 | **Phase 3 才用** |
| 调度 | **确定性执行器 + Redis Stream 队列** | — | 状态机、重试、断点续跑、去重 |

### 3.2 四处选型修正

1. **镜头切分不用 OpenCV 手写直方图差分**：对运镜、渐变转场、闪光误判率高，且属于重复造轮子。用 PySceneDetect。
2. **YOLOX / RT-DETR 从 Phase 2 起用**：Phase 1 拆帧不需要目标检测；Phase 2 起用于主体裁剪与一致性参考。
3. **不引入 Celery 管显存**：Celery 是跨进程的，管不到 ComfyUI/Ollama 的内存占用。真正的互斥靠「串行 + keep_alive=0 + 启动前查内存」（见 5.3）。
4. **图生视频不用 Wan2.1-1.3B**：它是 T2V（文生视频），没有图生能力，承接不了「关键帧动起来」。I2V 候选为 LTX-2B / SVD / Wan2.2-5B，最终型号由 Phase 0.5 实测决定。

---

## 四、流水线设计

### 4.1 六阶段流水线（phase-major，按模型分阶段独占内存）

**关键原则：不是逐镜头交替跑，而是按阶段批处理。**
Qwen2-VL + SDXL + I2V 加起来远超 48GB，任何两个都不能同时常驻。

```
阶段 A  探测 + 镜头切分 + 关键帧提取
        工具：probe_video / split_shots / extract_frames
        内存：无重型模型
        └─ 产物：shots.json、frames/*.png
                    │
阶段 B  关键帧语义打标（全部镜头）
        工具：describe_frames        模型：Qwen2-VL-7B Q4
        └─ 卸载 VLM（keep_alive=0）

阶段 B2 语义 → Profile 挂载（决策层纯函数，不占 L2 工具名额）
        输入：semantics JSON + 规则表（§4.6）
        输出：profile / look / bgm_tone，写 decision log
                    │
阶段 C  关键帧重绘（全部镜头）
        工具：render_frames          模型：SDXL（或 FLUX schnell）
        └─ 卸载扩散模型
                    │
阶段 D  逐镜头图生视频（全部镜头）
        工具：generate_clips         模型：LTX-2B / SVD / Wan2.2-5B
        └─ 卸载 I2V
                    │
阶段 E  插帧 + 超分 + 调色
        工具：interpolate / upscale / grade_color  模型：RIFE / Real-ESRGAN
        顺序：interpolate → upscale → grade_color（§4.5）
        └─ 30fps / 1080p / 已调色片段
                    │
阶段 F  音画 + 封装 + 归档
        工具：synthesize_audio / assemble / archive
        └─ 成片 mp4 + 交付包
```

- 每个阶段处理**全部镜头**后再进入下一阶段
- 阶段之间必须确认内存已释放（读 `vm_stat`，低于阈值继续等）
- 任一阶段失败：该阶段整体可重跑（工具幂等），不影响已完成阶段

**为什么不能逐镜头跑**：逐镜头意味着 20 次「载入 VLM → 卸载 → 载入 SDXL → 卸载 → 载入 I2V → 卸载」，模型加载时间会吃掉全部收益。

**每一步都写状态到 `state.json`，失败可从中断处续跑。**

### 4.2 数据契约 v1.1（先定死，否则结果不可复现）

```json
{
  "schema_version": "1.1",
  "video_id": "20261102_001",
  "shot_id": 3,
  "frame_ts": 12.40,
  "shot_start": 11.80,
  "shot_end": 15.20,
  "scene": "室内 / 产品特写",
  "subjects": [
    { "name": "咖啡杯", "bbox": [120, 80, 620, 700], "confidence": 0.92 }
  ],
  "style_keywords": ["暖光", "木质桌面", "浅景深"],
  "semantics": {
    "typology": "ad_product",
    "subject": { "kind": "product", "name": "咖啡杯", "count": 1 },
    "lighting": { "direction": "side", "quality": "soft", "time": "golden_hour", "temp_k": 4200 },
    "motion": { "camera": "static", "subject": "subtle", "intensity": 0.2 },
    "emotion": { "valence": 0.6, "arousal": 0.3, "tags": ["calm"] },
    "quality_flags": ["low_tension", "flat_light"],
    "confidence": 0.86
  },
  "profile": {
    "name": "ad_teal_orange",
    "source": "policy:typology_map",
    "confidence": 0.86,
    "reason": "typology=ad_product → 广告商业"
  },
  "consistency_ref": {
    "product_ref": "refs/product_01.png",
    "seed": 20261102
  },
  "prompt": "...",
  "negative_prompt": "...",
  "clip": {
    "i2v_model": "ltx-video-2b-i2v",
    "duration_s": 3.0,
    "native_fps": 24,
    "target_fps": 30,
    "resolution": [1080, 1920],
    "attempts": 2,
    "picked": "clip_02.mp4"
  },
  "model_meta": {
    "vlm": "qwen2-vl-7b-q4",
    "image_model": "sdxl-base",
    "prompt_version": "pt-v1",
    "workflow_version": "sdxl-base-v1",
    "i2v_workflow_version": "ltx-i2v-v1"
  }
}
```

**三条铁律**：

- `prompt_version` / `workflow_version` 每次改动必须递增
- ComfyUI 的 workflow JSON 存进 git，不靠「记得上次怎么调的」
- 同一份输入 + 同一版本号，产出必须可复现

### 4.3 成片形态：C · 关键帧重绘 + 图生视频（**已定**）

**产品定义**：每个镜头 → 关键帧 → SDXL 重绘 → I2V 生成 3~5 秒动态 → RIFE 补帧 → 1080p 超分 → 拼接 + 配音字幕 → 成片。

| 项 | 规格 |
|---|---|
| 单镜头时长 | 3~5 秒（由 I2V 原生能力决定） |
| 成片时长 | 15~60 秒（商业短视频），可拼到 3 分钟 |
| 镜头数 | 5~20 个 / 条 |
| 分辨率 | 1080×1920（竖屏）/ 1920×1080（横屏） |
| 帧率 | 30fps（I2V 原生 6~24 → RIFE 补齐） |
| 音频 | TTS 旁白 + 背景音乐；口播需 lip-sync（Phase 4） |
| 封装 | H.264（兼容优先）/ H.265（体积优先），AAC 192k |

**被否决的路线**（记录原因，避免反复）：
- A（保留原片中间帧）：本质是剪辑，不是重构，客户能看出是原片
- B（RIFE 直接插帧）：0.14fps 补到 30fps 会大面积形变

**代价（必须接受）**：
- 单条 3 分钟成片 **2~5 小时**
- I2V 失败率高，需要多次采样 + 自动筛选
- 一致性是最难的一条（见 4.4）

### 4.4 一致性策略（决定「能不能交付」）

| 维度 | 手段 |
|---|---|
| 产品外观跨镜头一致 | 固定产品参考图 + IP-Adapter；同一 `seed` 派生 |
| 风格一致 | 统一 style prompt + 同一基础模型 + 同一 LoRA 栈 |
| 色彩一致 | `grade_color`：参考镜头 LAB 匹配 + 统一 LUT（§4.5）；ΔE2000 判据见 §4.5 |
| 人物一致（如出现） | 角色 LoRA；否则避免多镜头露正脸 |
| 镜头衔接 | 相邻镜头首尾帧相近时优先；必要时用 FLF2V 做转场 |

**验收方式**：人工抽检 10 个片段，同一产品外观「肉眼可辨偏差」的比例 ≤ 2/10。

### 4.5 调色（Color Grading）

> 缺口：原方案只有「统一 LUT / 白平衡」一句，缺可执行的位置、工具与判据。I2V 逐段生成必然出现段间色偏，必须在拼接前收口。

**位置与顺序**：阶段 E 内 `interpolate → upscale → grade_color`，产物进阶段 F 封装。
- 放在超分**之后**：LUT 与匹配作用在最终分辨率上，避免「先调色再超分」被重采样二次改变；1080p 下 `lut3d` 为实时级，成本可忽略。
- **不做 diffusion 重绘式调色**：改色会连带改内容/纹理，破坏产品一致性；调色只用确定性色彩变换。

**四层设计（L1~L3 必做，L4 可选）**：

| 层 | 手段 | 实现 | 作用 |
|---|---|---|---|
| L1 基线 | 自动白平衡 + 曝光归一 | `ffmpeg eq` / `colorbalance` / `colortemperature`，或 OpenCV 灰世界 | 消除段间亮度/白平衡漂移 |
| L2 风格 | 3D LUT（`.cube`）+ 参数微调 | `ffmpeg lut3d=look.cube` + `eq=contrast:saturation` + 颗粒 | Director Profile 的「调色美学」 |
| L3 一致性 | 镜头间颜色匹配 | 参考镜头（默认第 1 镜或产品基准帧）→ LAB 均值/标准差仿射，按 `match_strength` 混合 | 跨镜头 ΔE 收口 |
| L4 增强（可选） | 局部二级调色（肤色/天空/产品） | OpenCV 掩膜 + 曲线 | 商业片精修；Phase 3 后再做 |

**四套 Profile 的色彩方向**（初版，可迭代）：

| Profile | 色彩基调 | 关键参数 |
|---|---|---|
| 广告商业 | 青橙、高对比、肤色干净 | 阴影偏青、高光偏暖、饱和 +8%、对比 +12% |
| 风景大片 | 低饱和高动态、蓝青阴影 | 饱和 −10%、对比 +15%、黑位压死 |
| 人物 Vlog | 暖肤、柔和、轻胶片 | 肤色 +3%、对比 −5%、颗粒 3%、黑位抬升 |
| 宣传纪实 | 中性、低饱和、纪实感 | 饱和 −15%、对比 +5%、轻微褪色 |

**工具契约**（新增 L2 工具，满足 §9.3 六条）：

```python
"grade_color": {
  "input": "clips/*.mp4",          # 阶段 E 的插帧+超分产物
  "look": "ad_teal_orange",        # Director Profile 名
  "lut": "looks/ad_teal_orange.cube",
  "match_ref": "shot_001",         # L3 参考镜头；null=只做 L1+L2
  "match_strength": 0.8,           # 0~1，防过度校正
  "grain": 0.0,                    # 可选颗粒强度
}
# 输出：graded/*.mp4 + color_report.json（每镜 LAB 均值/方差、ΔE2000 分布、clipped 比例）
# 幂等键：(input_hash, look, lut_hash, match_ref, match_strength, grain)
```

**数据契约新增**（§4.2 的 `look`）：

```json
"look": {
  "profile": "ad_teal_orange",
  "lut": "looks/ad_teal_orange.cube",
  "match_ref": "shot_001",
  "match_strength": 0.8,
  "grain": 0.0,
  "bypass": false
}
```

**验收判据**（并入 `quality_check` 与 §7.3）：

| 指标 | 通过标准 |
|---|---|
| 跨镜头平均 ΔE2000（对参考） | **≤ 3** |
| 跨镜头 ΔE2000 p95 | **≤ 6**（可交付）；≤ 10 可接受；> 10 触发加强匹配或重生成 |
| 高光/阴影裁切 | 各通道 clipped 像素 **< 0.5%** |
| 肤色 | 不偏绿/偏紫；与参考帧 ΔE 均值 ≤ 5 |
| 段间闪烁（调色引入） | 相邻段首尾帧亮度差 **< 3%** |
| 人工 A/B | 抽 10 段，明显「不是一条片子」≤ 1/10 |

**旁路与回退**：`look.bypass=true` 或 LUT 缺失 → 自动退回 L1（白平衡+曝光）只做基线，**不阻塞出片**；`color_report.json` 始终产出，供人工复核。

**色彩管理**：Real-ESRGAN 输出为 sRGB PNG；编码时显式 `-colorspace bt709 -color_primaries bt709 -color_trc bt709`，LUT 只在该域内应用，避免二次 gamma。渐变段如见 banding，加轻量 dither/grain 或 10-bit 中间编码。

**许可（C5）**：LUT 必须自制或用可商用授权（CC0 / 商用买断）；**禁止**打包来源不明的「电影感 LUT 合集」；优先用 ffmpeg 参数生成自有 LUT。

### 4.6 先理解、后重构：语义接地 → Profile 挂载

> 原则：**理解是因，风格 / 调色 / 音乐是果**。任何生成动作之前，先把画面解析成结构化语义；Profile 由语义**确定性映射**得出，不靠人现选。

**位置**：阶段 B（`describe_frames`）之后、阶段 C（`render_frames`）之前，新增 **B2 · select_profile**。

- 它是 **L3 决策层纯函数**，不是 L2 工具：无副作用、可重放、不占 14 个工具名额。
- LLM 可以建议 profile，但**规则表有一票否决**；LLM 不可用时 `default_policy()` 直接查表。

**默认映射表（`policy/typology_map.py`）**：

| typology | Profile | 调色 | BGM 基调 |
|---|---|---|---|
| `ad_product` | 广告商业 | `ad_teal_orange` | 干净、节奏中快、低频克制 |
| `landscape` | 风景大片 | `landscape_low_sat` | 史诗 / 环境，宽动态 |
| `vlog` | 人物 Vlog | `vlog_warm_film` | 轻快 / 氛围，中低音量 |
| `documentary` | 宣传纪实 | `doc_neutral` | 中性、克制 |
| `unknown` | 保守兜底 | `doc_neutral`（风格层 bypass） | 无 BGM 或极轻 |

**两条护栏**：

1. **语义不足不硬猜**：`confidence < 0.6` 或 `typology=unknown` → 兜底 Profile + `needs_human`（可配 `auto_continue`）。
2. **决策可审计**：`decision log` 记录 `semantics` 输入、命中规则、最终 `profile`、置信度；可重放。

**边界**：理解结果只决定**风格强度**，不改变**内容事实**——VLM 说咖啡杯，重绘必须还是咖啡杯；不得因 Profile 是「诺兰」就把杯子改成人。

**验收**：同一素材跑两次，`typology` / `profile` 选择一致（确定性）；人工抽检 10 条，Profile 明显不匹配 ≤ 1/10。

### 4.7 活人感（Human-likeness）

> 目标不是「更高清」，而是「不像 AI 做的」。AI 视频的破绽集中在：匀速运镜、塑料皮肤、完美对称、循环 BGM、无环境声、镜头时长整齐。活人感必须**工程化**，不能靠一句提示词。

**五个维度（写进 Profile 与 `quality_check`）**：

| 维度 | 要什么 | 不要什么 | 实现 |
|---|---|---|---|
| 运镜 | 轻微手持抖动、非匀速、呼吸感 | 机械匀速平移 | I2V motion 参数 + 后处理微抖（`crop` 随机偏移 ±1~2 px） |
| 人物 | 微表情、眨眼、发丝、皮肤纹理 | 蜡像脸、磨皮、对称五官 | 负向 prompt + 降低 denoise + 保留原片纹理 |
| 画面缺陷 | 轻颗粒、暗角、轻微色差、呼吸对焦 | 过度锐化、HDR 假亮 | `grade_color` 的 grain / vignette 参数（默认轻微） |
| 剪辑节奏 | 镜头时长有差异（如 2.1 / 3.4 / 4.8 s）、留呼吸口、动作衔接 | 每个镜头等长、硬切到底 | `assemble` 的节奏表；J-cut / L-cut（音频先入 / 后出） |
| 声音 | 环境底噪、房间混响、非循环 BGM、语音停顿 / 口癖 | 纯合成循环 BGM、无环境声 | `synthesize_audio` 混入 ambience bed；BGM 分段而非整段循环 |

**反 AI 感清单（`quality_check` 必检）**：

- 皮肤高频纹理能量 > 阈值（防磨皮）
- BGM 8 s 自相关无强重复峰（防循环）
- 镜头时长标准差 ≥ 0.6 s（防等长）
- 运动矢量方差 > 0（防静止 / 机械）
- 音频动态范围 > 8 LU（防压平）

**Profile 增字段**：`human: {handheld, grain, vignette, jitter_px, pacing_bias}`。

**验收**：10 段盲测（不给来源），「像真人拍的」≥ 7/10；任一客观代理指标不达标即 FAIL。

---

## 五、内存与并发

### 5.1 实际可用内存

64GB − 系统 ≈ **48GB 可被 Metal 使用**（macOS wired limit 约 75%）。

### 5.2 四档模型组合（按阶段独占，绝不并发）

| 阶段 | 常驻模型 | 内存占用 | 说明 |
|---|---|---|---|
| B 打标 | Qwen2-VL-7B Q4 | ~6GB | 阶段结束 `keep_alive=0` 卸载 |
| C 出图 | SDXL | ~8GB | 独占 |
| C 出图（高质） | FLUX.1 schnell fp16 + T5 | ~33GB | 仅关键镜头，慢 |
| **D 图生视频** | **LTX-2B / SVD / Wan2.2-5B** | **8~24GB（视型号）** | **本阶段必须无其它模型常驻** |
| E 插帧超分 | RIFE + Real-ESRGAN | ~4GB | 可批量 |

**硬规则**：进入阶段 D 前，必须确认 SDXL 与 Ollama 都已卸载；I2V 是所有阶段里内存最不可预测的一步。

### 5.3 阶段切换 + 卸载 + 内存守卫

```python
# 阶段切换：先卸载上一阶段模型，再检查内存，再加载新模型
def enter_phase(name, required_gb):
    unload_all_models()                  # Ollama keep_alive=0 + ComfyUI /free
    wait_until(lambda: available_mem_gb() > required_gb + 12, timeout=300)
    log_phase(name, available_mem_gb())
```

- Ollama 请求固定带 `"keep_alive": 0`
- 阶段切换时调用 ComfyUI 的 `/free` 释放模型
- I2V 阶段要求可用内存 > 模型体积 + 12GB 余量，否则等待或降级到小模型

### 5.4 为什么不用 Celery 管显存

Celery worker 与 ComfyUI、Ollama 是**三个独立进程**，Celery / Redis 的锁只能锁住任务，锁不住另外两个进程吃了多少内存。
**能管内存的只有：串行执行 + 主动卸载 + 事前检查。**

---

## 六、存储与运维

### 6.1 Docker 落 M.2 独立池（已确认支持）

> 同一块 M.2 只能二选一：**做 SSD 缓存就不能做存储池**。本项目选存储池。

1. 先确认 **未启用 SSD 缓存**：存储管理 → SSD 缓存 → 不分配该 M.2（若已分配，先移除缓存任务）
2. 存储管理 → 存储池与空间 → 创建 → 选择 M.2 → **Basic** → 创建存储空间 → **文件系统选 ext4**
3. Docker 管理 → **配置并迁移** → 选新存储空间 → 开始迁移
4. 迁移完成后确认：新空间已设为默认；**128GB 系统盘占用已释放**
5. 记录实际卷号（`df -h`），后续 compose 的 volume 路径统一指向该池

> 新存储池会拿到新的卷号（如 `/volume1`、`/volume3`），**不要照抄本文示例路径**，以 `df -h` 为准。
> 本文其余章节的 `/Volume2` 指 **RAID1 归档卷**。
>
> 为什么 ext4 不用 Btrfs：Docker/Qdrant 是随机写负载，Btrfs 的 CoW 会碎片化，开快照还会持续膨胀。
> **Btrfs 留给 RAID1 归档卷**（那里才需要快照）。

### 6.2 离线镜像与配置备份（离线环境的生命线）

M.2 挂掉时容器全部丢失，而离线环境 **pull 不到镜像**。装好验证通过后立即执行：

```bash
docker save -o /volume2/backup/images/qdrant.tar qdrant/qdrant:latest
docker save -o /volume2/backup/images/redis.tar  redis:7-alpine
cp docker-compose.yml /volume2/backup/
```

重建流程：换盘 → `docker load -i *.tar` → `docker compose up -d`，10 分钟恢复。

### 6.3 清理与保护

| 规则 | 动作 |
|---|---|
| Frame_Buffer 超过 48h 且任务已完成 | 校验归档 checksum 后删除 |
| NAS 容量 > 85% | 告警（不自动删） |
| 自动清理白名单 | `/Rendered_Outputs/`、`/Raw_Video_Assets/`、`/Docker_Volumes/` **永不自动删** |
| 首次插盘 | **会格式化**，旧盘必须先备份 |

### 6.4 数据保护

- **无 ECC 内存** → 位翻转无法检测，重要数据不能只有 NAS 一份
- **RAID1 ≠ 备份**（不防误删 / 勒索 / 控制器故障）
- 业务数据：RAID1 + 定期外置冷备；家庭数据：独立账号 + 权限隔离
- 3-2-1 的第三份（离线/异地）**Phase 3 前补齐**

### 6.5 UPS

- 600VA / 360W，**必须带 USB 通讯**
- 接：NAS + 光猫 + 路由器（保证断电时还能发告警、刷完缓存）
- **不接**：Mac Studio（功耗大，且内部无机械盘）
- 待确认：UGOS Pro 能否识别该 UPS 并自动关机

### 6.6 产物归档与本地留存

**铁律：处理中写本地，处理完才搬 NAS。** 直接往 SMB 写，挂载一卡整个渲染就冻住。

| 层 | 位置 | 内容 | 生命周期 |
|---|---|---|---|
| 热 | Studio 本地 | 模型 / venv / 帧缓冲 / 当前 work | 任务结束即清 |
| 温 | Studio 本地 | 最近 7 天交付缓存 | 超期自动删 |
| 冷 | **NAS RAID1** | 成片 / 交付包 / 素材 / 中间产物 | 长期 |

NAS 目录：

```
/Volume2/KexLabs/
├── 00_inbox/                     待处理素材
├── 10_projects/<客户>/<项目>/
│   ├── source/                   原始素材（只读）
│   ├── work/                     中间产物（保留 30 天）
│   ├── deliver/                  最终交付
│   └── state/                    state.json + decisions.jsonl
└── 90_archive/                   完结项目（YYYY/MM）
```

**`archive` 工具六步：**

1. 空间预检（NAS 剩余 < 100GB 直接拒）
2. `rsync -a --checksum` 传到 `.tmp/`
3. 校验 manifest 的 sha256
4. 校验通过后原子 rename 落位
5. 删除本地 work
6. 保留最近 7 天本地缓存

**四条约束：**

- **不挂载 SMB/NFS 给流水线写**，用 rsync over SSH 主动推
- ComfyUI 必须 `--output-directory ~/kex/work/<job_id>/comfy`
- `state.json` / `decisions.jsonl` **本地优先**，异步同步到 NAS（NAS 挂了也能续跑）
- 归档失败只标 `archive_pending`，**不影响成片的成功判定**

**容量：**

| 项 | 单条 |
|---|---|
| 成片 60s 1080p | 50~150MB |
| 中间产物 | 400~500MB |
| 交付包 | ~600MB |

100 条/月 ≈ 60GB/月；Studio 稳态 ≈ 345GB / 1TB。

---

## 七、验收判据（可量化）

> 引入 I2V 后，全局时间指标失效。以下按阶段与镜头重算。

### 7.1 Phase 0 · 基础冒烟（半天）

| # | 测试 | 通过标准 |
|---|---|---|
| 1 | Ollama 跑 1 张图出 JSON | 单帧 < 5s |
| 2 | ComfyUI 出 1 张 SDXL 1024² | 首张 < 60s（含加载），稳定后 < 20s |
| 3 | ffmpeg + PySceneDetect 切 30s 1080p | 切分 < 10s |
| 4 | Mac ↔ NAS 万兆直连拷 10GB | > 800MB/s |

### 7.2 **Phase 0.5 · I2V 可行性闸门（半天，决定项目是否成立）**

I2V 在 MPS 上最常见的两种失败：`NotImplementedError`（FlashAttention / xformers / conv3d 未实现）与 `MPS backend out of memory`。
**必须分级往上爬，不要一上来就测 1080p。**

| 级 | 内容 | 通过才进下一级 |
|---|---|---|
| **L0** | 模型能加载，出 1 帧、1 step | 不报 `NotImplementedError` |
| **L1** | **16 帧 @ 512×288**，4~8 steps | < 5 分钟 |
| **L2** | 49 帧 @ 768×512 | < 10 分钟 |
| **L3** | 121 帧 @ 768×512 | < 15 分钟 |

L3 通过后再补三项：RIFE 到 30fps（< 2 分钟）、超分到 1080p（< 5 分钟）、人工判定（无形变、无闪烁、产品外观与输入一致）。

诊断用环境变量：

```bash
export PYTORCH_ENABLE_MPS_FALLBACK=1          # 算子缺失时回落 CPU（极慢，仅诊断）
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0   # 取消上限（最后手段，可能拖垮整机）
```

- **计时以第二次运行为准**，首次包含 MPS kernel 编译
- 任一级不过 → 换模型（SVD / Wan2.2-5B）从 L0 重来；仍不过 → 退回 A，或评估加硬件

> 这是整个项目唯一的 **Go / No-Go 闸门**。没过之前不要排产。

### 7.3 各阶段 Exit Criteria

| 阶段 | 交付 | 通过标准 |
|---|---|---|
| Phase 1 | 六阶段串成一条命令，跑完 1 个镜头 | 全链路可续跑；状态完整；阶段间内存正确释放 |
| Phase 2 | 一条 30 秒成片（5~8 镜头） | 端到端 ≤ 60 分钟；一致性抽检偏差 ≤ 2/10；色彩 p95 ΔE2000 ≤ 6（§4.5） |
| Phase 3 | 一条 60 秒成片（10~15 镜头） | 端到端 ≤ 2 小时；音画同步；可交付；色彩 p95 ΔE2000 ≤ 6（§4.5） |
| Phase 4 | 批量 5 条无人值守 | 失败可续跑；自动报告；口播 lip-sync（可选） |

> 时间随镜头数线性增长：**约 5~15 分钟 / 镜头（I2V 阶段占 70%）**。
> 不要再用「3 分钟素材 = 15 分钟」这类全局指标。
> 色彩按 §4.5 验收：跨镜头平均 ΔE2000 ≤ 3、p95 ≤ 6。

---

## 八、待决事项与风险

### 8.1 决策清单

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | 成片形态 A / B / C | — | ✅ **已定 C** |
| 2 | I2V 型号（LTX-2B / SVD / Wan2.2-5B） | 决定 Phase 0.5 能否通过 | ⏳ Phase 0.5 实测后定 |
| 3 | 是否有人物口播（需 lip-sync） | 决定是否引入 Phase 4 | ❓ 待确认 |
| 4 | 交付规格（竖屏/横屏、时长、平台） | 决定输出参数 | ❓ 待确认 |
| 5 | UPS 型号 & UGOS 联动 | 买绿联还是 APC | ❌ 待确认 |
| 6 | 七彩虹 CF600 是否单面 2280 | 可能塞不进 NAS 的 M.2 槽 | ⚠️ 待确认 |
| 7 | 网线长度与根数 | 直连需 1 根 + NAS 接路由 1 根 | ⚠️ 待测量 |
| 8 | 记忆体部署位置 | 决定迁移步骤与资源分配 | ✅ 已定：NAS 跑服务 + Studio 跑 Ollama（第十二章） |

### 8.2 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **I2V 在 MPS 上跑不动 / OOM** | **高** | C 方案不成立 | Phase 0.5 先验；不过就换 SVD 或退回 A |
| I2V 单镜头 > 15 分钟 | 高 | 产能不足 | 降分辨率/步数；只对关键镜头用 I2V |
| **跨镜头一致性差** | **高** | 无法交付 | 固定 seed + IP-Adapter + LoRA；抽检门禁 |
| 形变 / 闪烁 | 高 | 需反复重采样 | 多次采样 + Agent 自动筛选（9.6） |
| 64GB 内存天花板 | 高 | 无法并行多模型 | 阶段化独占（4.1），接受吞吐代价 |
| 单机产能 3~5 条/天 | 中 | 商业上量受限 | 明确产能预期；扩产需加机器 |
| FLUX schnell 慢 | 中 | 出图超时 | 默认走 SDXL |
| PySceneDetect 误判 | 中 | 关键帧漏采 | AdaptiveDetector + 抽检 |
| VLM JSON 不稳定 | 高 | Prompt 波动 | schema 校验 + 重试 ≤2 |
| UPS 与 UGOS 不兼容 | 中 | 断电保护失效 | 改买 APC BK650M2-CH |
| M.2 盘故障 | 低 | 容器全丢 | 镜像 tar + compose 备份 |

---

## 九、Agent 全编排架构（决策层与执行层分离）

### 9.1 四层结构

```
┌─────────────────────────────────────────────────────┐
│ L4 · 开发期编排（opencode Master，人机协作）           │
│   写代码、跑验收、排障、发起批次 —— 只存在于开发阶段    │
├─────────────────────────────────────────────────────┤
│ L3 · 运行期 Agent Orchestrator（orchestrator.py）     │
│   LLM 看 state → 选工具+参数 → 看结果 → 下一步         │
│   跑在 launchd，不依赖任何会话                         │
├─────────────────────────────────────────────────────┤
│ L2 · Tool Executor（确定性）                           │
│   闭集白名单 · schema 校验 · 幂等 · checkpoint         │
│   重试/超时/降级 · 并发=1 · 内存锁 · 旁路              │
├─────────────────────────────────────────────────────┤
│ L1 · 模型服务（无状态）                                 │
│   Ollama / ComfyUI / Qdrant                           │
└─────────────────────────────────────────────────────┘
```

**两条铁律**：

1. L3 只能调 L2 暴露的工具，**不能直连 L1**。
2. L2 不调用 L3——执行层不能反过来请求决策，避免递归与死锁。

### 9.2 角色分工

| 层 | 谁 | 负责 | 不负责 |
|---|---|---|---|
| L4 | opencode Master | 开发、验收、排障、发起批次 | 生产运行时 |
| L3 | orchestrator.py + 本地 LLM | 决策选择 | 执行保证 |
| L2 | pipeline tools | 执行、幂等、恢复 | 判断「该不该做」 |
| L1 | ComfyUI / Ollama | 推理 | 状态管理 |

### 9.3 工具契约（L2 唯一对外接口）

每个工具必须满足六条，缺一不可：

1. **闭集**：Agent 只能从 `TOOLS` 里选，不存在「临时写个脚本」
2. **schema**：入参用 JSON Schema 校验，越界直接拒
3. **幂等**：同 `(tool, args, input_hash)` 重放不产生重复副作用
4. **自持久化**：执行前后写 `state.json`，进程崩溃可从断点恢复
5. **自处理失败**：重试 ≤2 次、超时、降级，全部内部完成
6. **结构化返回**：`{status: ok|failed|blocked|needs_human, output, error, cost}`

```python
TOOLS = {
  "probe_video":      {},   # 时长/分辨率/帧率/码率
  "split_shots":      {},   # 镜头切分，可带阈值
  "extract_frames":   {},   # 每镜头 1~3 帧
  "describe_frames":  {},   # VLM 打标 → JSON
  "render_frames":    {},   # 关键帧重绘
  "generate_clips":   {},   # 图生视频（逐镜头，多候选）
  "interpolate":      {},   # RIFE 补帧到 30fps
  "upscale":          {},   # 超分到 1080p
  "grade_color":      {},   # 调色：LUT + 镜头间匹配（§4.5）
  "synthesize_audio": {},   # TTS 旁白 / ASR 字幕
  "assemble":         {},   # 拼接 + 封装
  "quality_check":    {},   # 一致性 / 闪烁 / 形变 / 活人感（§4.7）自动判定
  "archive":          {},   # 校验 + 归档
  "ask_human":        {},   # 卡住时叫人
}
```

> `select_profile` / `classify_video_type` 属 **L3 决策层纯函数**，不占 L2 工具名额（当前 14 个），见 §4.6。

### 9.4 Orchestrator 主循环

```python
def run_job(job):
    state = load_state(job.id)
    while not state.done:
        if state.step >= MAX_STEPS:
            return state.block("step budget exhausted")

        d = llm_decide(goal=job.goal, state=state.summary(),
                       tools=TOOLS, steps_left=MAX_STEPS - state.step)
        if d is None:                        # LLM 不可用 / 返回不可解析
            d = default_policy(state)        # 旁路：确定性默认流程
        validate(d, TOOLS, state)            # 白名单 + schema + 前置条件
        r = execute(d, state)                # 幂等 + checkpoint + 重试 + 超时
        state.record(d, r)                   # decision log
        if r.status == "needs_human":
            notify_and_wait(r)
    return state.report()
```

队列使用 **Redis Stream**（`XADD` / `XREADGROUP` + `XAUTOCLAIM` 恢复未 ack 任务），不使用目录轮询。配置见 11.2。

**长任务防重投，三层缺一不可：**

| 层 | 做法 |
|---|---|
| 分队列 | 每阶段独立 stream；`q:clips` 的 idle 阈值 **30~40 分钟**，其它阶段 5 分钟 |
| 心跳 | worker 每 60 秒对处理中的消息 `XCLAIM ... JUSTID` 续命 |
| **单项锁** | `SET lock:clip:{shot_id} 1 NX EX 1800`——同一镜头只能有一个 worker 跑 |
| 幂等兜底 | `(tool, args, input_hash)` 命中缓存直接返回 |

> `XCLAIM` 只是续命，挡不住两个 worker 同时开始；**单项锁才是真正的互斥**。

`validate()` 与 `execute()` 是确定性的——这就是「不会翻车」的部分。
Agent 的自由度只存在于「选哪个、传什么参数」。

### 9.5 八个失控点与防线

| 失控点 | 防线 |
|---|---|
| 调用了不存在的工具 | 闭集白名单 + schema 校验，不在集合里直接拒 |
| 参数乱填 | JSON Schema + 范围检查（如 `threshold ∈ [0.1, 0.9]`） |
| 死循环 | 步数上限 + 状态哈希去重 + 预算 |
| 失败后还继续 | 工具返回结构化 error，executor 拦截并标记 blocked |
| 重复副作用 | 每步幂等：按 `(tool, args, input_hash)` 命中缓存 |
| 不可复现 | decision log + prompt / workflow 版本号 |
| 抢内存 | executor 串行 + `/tmp/kex_pipeline.lock` |
| 无人值守出错 | `ask_human` 工具 + 告警通道 |

### 9.6 哪些节点值得让 Agent 决策

| 节点 | 为什么需要判断 |
|---|---|
| 镜头切分阈值 | 快节奏广告 vs 慢镜头产品片，阈值不同 |
| 关键帧取舍 | 「哪一帧最能代表这个镜头」没有固定公式 |
| 重绘质量判定 | 出来的图糊了/变形了，要不要重跑 |
| 模板 / 风格选择 | 按客户、品类、平台选不同风格 |
| **失败归因** | 模型问题、素材问题还是参数问题 |
| **片段筛选** | 同一镜头生成 2~3 个候选，挑形变最少的一个 |

**这些是判断，不是执行。** 一次视频约 5~15 个决策点，不是每帧都调 LLM——成本和延迟都可控。

### 9.7 旁路：Agent 是加速器，不是单点故障

```python
if not orchestrator_available() or timed_out:
    return default_policy(state)     # 固定规则：按预设流程走完
```

**LLM 挂了、慢了、返回不可解析 → 任务必须继续跑完。**
这是「Agent 全编排」与「生产可靠」能同时成立的唯一办法。

### 9.8 批量任务与会话硬闸

Master 会话有硬约束：`turns ≥ 120`、上下文水位、累计 50M tokens、15 个工作包 / 30 次派发，任一触顶即禁止继续派活。
**「批量处理 100 条视频」不能拆成 100 个 task。**

正确形态：一次派发，后台跑完，只取报告。

```bash
nohup python orchestrator.py --batch /volume2/Raw_Video_Assets/2026-11/ \
      --out /volume2/Rendered_Outputs/2026-11/ \
      > /volume2/logs/batch_20261102.log 2>&1 &
```

派给 `dev` 的工单只有一句：「跑这批，产出 `report.json`，失败条目写 `failed.json`」。
Master 不读流水日志、不逐条追问（后台跑，落盘后只读一次）。

### 9.9 内存互斥必须跨层

`resource-guard` 只检查子 agent 数量和系统可用内存，**它不知道 ComfyUI 正在吃 30GB**。

> Master 派发任何写码/构建类子任务前，必须先确认流水线没在跑重型模型。

**用 `flock`，不用 PID 探测。**

```python
import fcntl

lockf = open("/tmp/kex_pipeline.lock", "w")
try:
    fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    return "pipeline busy"
lockf.write(f"{os.getpid()}\n")   # 只给人和排查用，不参与判断
# 进程无论正常退出还是段错误崩溃，内核都会自动释放
```

**为什么不用「写 PID + `kill -0` 探测」**：进程崩溃后 PID 可能被系统复用，`kill -0` 会返回「活着」，锁就永远不放。`flock` 由内核管理生命周期，不存在僵尸锁。

另外：

- 跑批期间 Master 只做只读操作（Fast Path）
- 锁文件里同时写 `pid / host / job_id / start_time`，便于人工排查

这是 C2（64GB 生存线）在编排层的投影——**内存预算不只在 pipeline 里算，也在「谁在派活」这一层算。**

### 9.10 验收闭环（复用现有机制，不新造）

| 环节 | 机制 | 产物 |
|---|---|---|
| L2 开工前 | 冻结契约表 | `acceptance/<id>/contract.md` |
| 实施 | `dev` 自测 | 代码 + 运行日志 |
| 黑盒验收 | `acceptance-tester` 逐行判 | PASS/FAIL + 逐条证据 |
| 白盒审查（触及共享契约时） | `reviewer` 上下文闭包 | findings |
| 收口 | 四步回对 + VERIFIED 盘 | 结项记录 |

**视频平台特有判据**（补进契约表）：

- 产出帧数 = 镜头数 × 1~3（允许 ±10%）
- `report.json` 的 `failed` 为空，或每条失败都带 error 字段
- 关键帧重绘：抽检 10 张 ≥ 7 张可用（看「单张好不好」）
- 片段一致性：抽检 10 个片段，肉眼可辨偏差 ≤ 2/10（看「跨镜头是否一致」，见 4.4）
- 全流程耗时不超 7.3 的指标
- **决策可审计**：每条视频的 decision log 完整，可重放

### 9.11 项目目录约定

```
kex-labs-video/
├── AGENTS.md                  # 项目事实：命令、路径、模型、约束
├── .opencode/state/TASK.md    # 只有 Master 写
├── acceptance/<id>/contract.md
├── orchestrator.py            # L3 决策层
├── tools/                     # L2 每个工具一个模块（14 个）
│   ├── probe_video.py
│   ├── split_shots.py
│   ├── extract_frames.py
│   ├── describe_frames.py
│   ├── render_frames.py
│   ├── generate_clips.py
│   ├── interpolate.py
│   ├── upscale.py
│   ├── grade_color.py
│   ├── synthesize_audio.py
│   ├── assemble.py
│   ├── quality_check.py
│   ├── archive.py
│   └── ask_human.py
├── policy/default_policy.py   # 旁路：确定性默认流程
├── state/<job_id>.json
├── decisions/<job_id>.jsonl   # decision log
├── workflows/                 # ComfyUI workflow JSON（进 git，带版本号）
├── prompts/                   # prompt 模板（带版本号）
└── reports/                   # 每批的 report.json / failed.json
```

### 9.12 生产运行 ≠ Agent 会话

- **生产调度**：macOS `launchd` / `cron` + `orchestrator.py`，**不在 opencode 会话里跑**
- **Agent 会话**：只用于开发、验收、排障、发起批次
- **理由**：会话有上下文与步数上限，且会话关闭 = 进程终止；生产必须能脱离会话独立运行

### 9.13 实施顺序（不能反）

```
Phase 0.5  I2V 可行性验证（见 7.2）——不过不排产
Phase 1    把六阶段的 14 个工具做成可靠实现（闭集 + schema + 幂等 + state + 重试）
Phase 2    加 Agent 决策层，只覆盖 3 个节点（切分阈值 / 关键帧 / 片段筛选）
Phase 3  全链路编排 + decision log + 旁路 + 失败归因
```

**反过来做会翻车**：把 Agent 放在一堆不稳定脚本之上，它会稳定地做错事。

### 9.14 四条红线（写进项目 AGENTS.md）

1. **Agent 只调 L2 工具，不直连 ComfyUI/Ollama 内部队列**
2. **锁、重试、幂等、状态持久化由代码负责，不由 Agent 负责**
3. **LLM 不可用必须能旁路跑完，Agent 不是单点故障**
4. **流水线在跑时，Master 只读**（避免抢内存，C2）

### 9.15 版本与提交纪律（NAS Gitea）

- **唯一远端**：`http://192.168.3.14:3000/gitadmin/kex-labs-video.git`；tailnet 走 `http://100.123.73.123:3000`。
- **代码只在 Studio 提交与推送**；MacBook 不 clone（§10.2）。
- **提交粒度**：一个工具 / 一个修复 / 一个契约变更 = 一次提交；**测试绿了才提交**。
- **推送时机**：每个里程碑步骤完成即 push，**不攒批**；禁止「等功能全做完再提交」。
- **分支**：`main` 保持可跑；里程碑用 `m1-scaffold` 这类短分支，验收后合并。
- **提交信息**：`<type>(<scope>): <what>` + 一行原因；type ∈ feat / fix / test / docs / chore。
- **不提交**：`.venv/`、`jobs/`、`state/`、`reports/` 的大产物、模型权重、密钥。
- **验收锚点**：每个里程碑打 tag（`m1` / `m2`），tag 对应 `acceptance/<id>/report.json`。

---

## 十、三端分工与远程接入（MacBook / Studio / NAS）

### 10.1 角色定义

| 端 | 硬件 | 角色 | 承担算力 | 安装 |
|---|---|---|---|---|
| **MacBook** | M1 / 16GB | 控制台 + 编辑器前端 | **零**（不参与任何视频处理） | Tailscale、终端、VS Code(Remote-SSH)、浏览器 |
| **Studio** | M5 Max / 64GB | 唯一 AI 算力 + 控制面 | VLM / 扩散 / 合成 | orchestrator、ComfyUI、Ollama、SSH、看板 |
| **NAS** | i3-1315U / 16GB | 存储 + 轻量服务 + 转码 | ffmpeg Quick Sync | Docker、Redis、Gitea、Qdrant |

### 10.2 四条硬规则

1. **MacBook 不跑 VLM、不跑扩散、不转码**
2. **MacBook 不 clone 仓库、不建 venv**（代码和依赖都在 Studio）
3. **MacBook 不传素材**（素材先进 NAS，MacBook 只提路径）
4. **MacBook 只发指令、只看结果**

### 10.3 网络接入

| 场景 | 方案 |
|---|---|
| 同一 Wi-Fi | 局域网直连，零配置 |
| 出门（4G / 外部 Wi-Fi） | **Tailscale**（首选，5 分钟）/ 不稳则自建 WireGuard + 便宜 VPS |

Tailscale 说明：端到端加密，P2P 打洞成功时不经过第三方；打洞失败走 DERP 中继。对外网访问通道而言可接受，**AI 流水线本身仍全本地**。

### 10.4 三个必须配置的可靠性项

**① 禁止 Studio 睡眠**（出门后睡死 = 全部失联，最容易踩的坑）

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10
```

**② 断电恢复后自动开机**

```bash
sudo pmset -a autorestart 1
```

**③ 光猫 + 路由器也接 UPS**
网络设备断电，Studio 活着也对外失联。

### 10.5 日常操作（照抄即可）

```bash
ssh studio                                    # 进 Studio
kexctl status                                 # 队列 / 当前任务 / 机器状态
kexctl submit /volume2/Raw_Video_Assets/xxx.mp4
kexctl logs 20261102_007
kexctl report --yesterday
ssh nas && docker ps                          # 管 NAS 容器
```

浏览器：

```
http://studio:8080             看板
http://nas:6333/dashboard      Qdrant
http://nas:9000                Portainer
```

手机：装 Tailscale + 浏览器即可看进度，不必带笔记本。

### 10.6 VS Code Remote-SSH（推荐）

代码在 Studio、venv 在 Studio，MacBook 只当显示器。
16GB M1 不装 PyTorch、不跑编译，日常使用不受影响。

### 10.7 服务暴露矩阵

| 服务 | 监听地址 | MacBook 访问方式 |
|---|---|---|
| SSH | `studio` tailscale IP : 22 | `ssh studio` |
| 看板 | `studio` tailscale IP : 8080 | 浏览器 |
| ComfyUI | `127.0.0.1:8188` | SSH 隧道 |
| Ollama | `127.0.0.1:11434` | 不需要外部访问 |
| Qdrant | NAS 内网 : 6333 | 浏览器 / HTTP |
| Portainer | NAS 内网 : 9000 | 浏览器 |
| Gitea | NAS 内网 : 3000 / : 2222 | 浏览器 / git over SSH |
| Redis | NAS 内网 : 6379 | **不对 MacBook 暴露**，需要时走 SSH 隧道 |
| 记忆体 API | NAS 内网 : 8010 | 浏览器 / HTTP（MacBook 与 opencode 客户端） |

**任何服务都不绑 `0.0.0.0`。** ComfyUI 与 Qdrant 默认无鉴权，绑全地址等于裸奔。

### 10.8 SSH 隧道（不暴露端口的备选）

```bash
ssh -L 8188:127.0.0.1:8188 studio     # 然后本地访问 localhost:8188
```

### 10.9 安全

- Tailscale ACL 只放行必要端口：`macbook → studio:22,8080`、`macbook → nas:6333,9000`、`phone → studio:8080`，其余拒绝
- SSH 仅密钥登录，禁密码
- 不开放任何公网端口
- NAS 管理界面不对公网暴露

### 10.10 验收

> 在 4G 网络下，MacBook 执行 `ssh studio kexctl status`，**3 秒内返回完整状态** → 第十章完成。

---

## 十一、内网基础服务栈（NAS Docker）

### 11.1 服务清单

| 服务 | 镜像 | 内存 | 磁盘 | 用途 | 级别 |
|---|---|---|---|---|---|
| **Redis 7** | `redis:7-alpine` | 0.5~1GB | 2GB | 任务队列 / 去重 / 状态缓存 / 个人开发 | **必需** |
| **Gitea** | `gitea/gitea:1.22` | 0.3~0.5GB | 10GB | 私有 Git（代码 / workflow / prompt / 文档） | **必需** |
| **Caddy** | `caddy:2-alpine` | 0.05GB | 1GB | 反向代理 + Basic Auth | 建议 |
| **Portainer** | `portainer/portainer-ce` | 0.1GB | 1GB | 容器管理界面 | 建议 |
| **Qdrant** | `qdrant/qdrant` | 2~8GB | 30GB | 向量库（Phase 3） | Phase 3 |
| **Uptime Kuma** | `louislam/uptime-kuma` | 0.15GB | 1GB | 探活 + 告警 | 可选 |
| restic | 无常驻容器（cron） | — | — | 加密备份 | 建议 |

内存合计（不含 Qdrant 增长）：**约 4GB / 16GB**。

### 11.2 Redis（队列底座，三个配置坑）

```conf
appendonly yes
appendfsync everysec
maxmemory 1gb
maxmemory-policy noeviction
dir /data
```

| 配置 | 为什么 |
|---|---|
| `maxmemory-policy noeviction` | **当队列用绝不能淘汰**。设成 `allkeys-lru`，内存紧张时任务会被静默删掉 |
| `appendonly yes` + `everysec` | 断电最多丢 1 秒的入队记录 |
| 数据卷挂 NAS 本地 M.2 | 不要挂 NFS——AOF 依赖 fsync 语义 |

**队列用 Stream，不用 LIST**：

```
XADD      jobs * video_id ...        # 入队
XREADGROUP GROUP orch worker1 ...    # 取任务，自动进 pending
XACK      jobs orch <id>             # 完成确认
XAUTOCLAIM jobs orch 60000 ...       # 超时任务重投（断电恢复靠这个）
```

**去重**（同一素材重复提交）：

```
SET job:dedupe:{content_hash} 1 NX EX 604800
```

**命名空间隔离**（pipeline 与个人开发互不污染）：

```
kex:pipeline:*    db0   orchestrator 队列与状态
kex:dev:*         db1   个人开发缓存
```

### 11.3 Gitea（私有 Git）

部署要点：

- 镜像 `gitea/gitea:1.22`，数据库用 SQLite
- **数据目录放 SSD 应用池**：git 对象与 SQLite 都是小文件随机 I/O，正是独立池要解决的问题；不放 NFS
- 单盘 SSD 无冗余 → **安全靠备份不靠 RAID**：`gitea dump` 每日到 RAID1，restic 每周到外置冷备，RPO ≤ 24h
- 端口：`3000` web，`2222` ssh（不占用 NAS 自己的 22）

仓库规划：

```
kex-labs/pipeline     orchestrator.py + tools/
kex-labs/workflows    ComfyUI workflow JSON（必须打 tag）
kex-labs/prompts      prompt 模板（必须打 tag）
kex-labs/docs         本方案 v3.x 各版本
kex-labs/infra        docker-compose / 部署脚本 / .env.example
```

**强制规则**（对应 4.2 三条铁律）：

- workflow JSON 与 prompt 模板改动 → 必须 commit + tag
- tag 名与 `model_meta.workflow_version` 保持一致
- 任何「线上正在跑」的版本，必须能在 tag 里找到

备份：`gitea dump` 每天一次 → RAID1 另一目录。
离线：`docker save gitea/gitea:1.22 -o .../gitea.tar`。

### 11.4 Caddy（给无鉴权服务加一层）

ComfyUI / Qdrant / Redis 默认无鉴权。绑 `127.0.0.1` 最安全但不好用，绑内网又裸奔。用 Caddy 统一入口：

```caddy
:8188 {
  basic_auth { kex <bcrypt哈希> }
  reverse_proxy 127.0.0.1:8188
}
:6333 {
  basic_auth { kex <bcrypt哈希> }
  reverse_proxy 127.0.0.1:6333
}
```

- 只监听 Tailscale 接口
- 密码用 `caddy hash-password` 生成

### 11.5 监控与告警

- **Uptime Kuma**：探活 Redis(6379) / Gitea(3000) / Qdrant(6333) / ComfyUI(8188) / Studio SSH(22)
- 告警渠道：SMTP 或本地 Webhook，**不用境外 SaaS**
- 机器指标先落盘（`vm_stat` / `docker stats` 每分钟一行）
- **先别上 Prometheus**，等真需要趋势图再说

### 11.6 备份

| 对象 | 方式 | 频率 |
|---|---|---|
| Gitea | `gitea dump` | 每天 03:00 |
| Redis | AOF 文件拷一份 | 每天 03:10 |
| Qdrant | snapshot API | 每天 03:20（Phase 3 起） |
| Compose / `.env` | 提交到 `infra` 仓库 | 变更即提交 |
| 素材与产物 | 已在 RAID1，另做外置冷备 | 每周 |

**没演练过的备份等于没有备份**——每月做一次 restore 演练。

### 11.7 NAS 资源预算（16GB，重新评估）

**结论：16GB 在 Phase 1–2 够用，但只是「够」，不是「宽裕」；Phase 3 上视频向量集合后，默认要升 32GB。**

#### 11.7.1 稳态与单项峰值

| 项 | 稳态 | 单项峰值 | 说明 |
|---|---|---|---|
| UGOS Pro 系统（SMB / 索引 / 日志 / 监控） | 1.5~2.0GB | 3.0GB | 媒体索引与缩略图生成是最大变量，媒体卷关掉自动索引 |
| Docker daemon + containerd + overlay | 0.3~0.5GB | 1.5GB | 峰值 = 拉镜像 / build |
| Redis（`maxmemory 1gb`） | 0.4~0.8GB | 1.0GB | noeviction，到顶写失败，不会静默超限 |
| PostgreSQL + pgvector | 0.6~1.0GB | 1.2GB | `shared_buffers=512MB` |
| memory API（uvicorn 1 进程 + torch + reranker） | 3.3~3.8GB | 4.0GB | reranker fp32 ≈2.3GB + torch ≈1GB，**只有一份** |
| memory Worker（Celery 并发 2，不加载 reranker） | 0.3~0.6GB | 1.0GB | 并发 8 会翻到 4GB+ |
| Qdrant（≤30 万向量，内存态） | 1.0~2.0GB | 3.0GB | 建索引 / snapshot 时冲高 |
| Gitea（SQLite） | 0.3~0.5GB | 0.6GB | |
| Caddy + Portainer + Uptime Kuma | 0.2~0.3GB | 0.4GB | |
| restic / dump 定时任务 | 0~0.2GB | 0.8GB | 03:00 备份窗口 |
| **合计（不叠加峰值）** | **7.9~11.7GB** | — | 稳态余量 **4.3~8.1GB** |

> **峰值列是单项上限，不能直接相加**。可控峰值（备份、媒体索引、镜像构建、Qdrant 建索引）必须错峰编排。

组合场景：

| 场景 | 估算占用 | 余量 | 处置 |
|---|---|---|---|
| 日常（服务全起，无备份 / 索引） | 9~11GB | 5~7GB | 正常 |
| 备份窗口 + 媒体索引 + Qdrant snapshot | 13.5~14.5GB | 1.5~2.5GB | 允许，但必须错峰；出现 swap 即调度失败 |
| 备份 + 10GbE 大文件写 + 并发检索 | 15GB+ | <1GB | **禁止**：写操作限速，备份期间不跑 re-embed |

#### 11.7.2 Phase 3 的变化（真正的分水岭）

记忆集合 30 万向量 → 记忆 + 视频 `clip_*`，上限 100 万。1024 维 float32 原始向量约 4GB，加 HNSW 图与 payload，内存态需 5~6GB：

- **不调优**：总占用 14~16GB，必然 OOM 或长期 swap → **必须升 32GB**
- **调优后**（向量 `on_disk` + int8 scalar quantization + payload on_disk）：Qdrant 降到 1.5~2.5GB，16GB 可撑到约 50~80 万向量
- **决策点**：Phase 3 开工前二选一 —— 升 32GB，或接受量化召回损失并压到 50 万向量以内

#### 11.7.3 不做 SSD 缓存对内存的影响

- **正面**：省掉缓存元数据与回写缓冲，通常几百 MB 级；更关键的是少了一个随写入波动的动态项。
- **负面**：HDD 侧随机读没有二级缓存。但冷归档池只做顺序大文件（素材 / 成片 / Frame_Buffer 归档），且 6.6 已规定「处理中写本地」，不依赖 NAS 侧缓存。
- **净结论**：不做缓存对 16GB 是**小幅正收益 + 可预测性提升**，不是主要矛盾；主要矛盾仍是 **Qdrant 增长** 与 **reranker 复制**。

#### 11.7.4 取证口径（别只看 `free`）

| 指标 | 命令 | 判据 |
|---|---|---|
| 可用内存 | `free -m` 的 `available` | 稳态 > 4GB；连续 7 天 < 4GB → 升级 |
| 内存压力 | `cat /proc/pressure/memory` 的 `some avg10` | > 10 且持续 5 分钟 = 已在 swap 抖动 |
| swap 使用 | `free -m` 的 swap `used` | > 1GB 且不回落 → 预算不足 |
| OOM | `dmesg \| grep -i "killed process"` | 出现 1 次即判失败 |
| 容器占用 | `docker stats --no-stream` | 单容器超 `mem_limit` 80% 要查 |
| 页缓存 | `/proc/meminfo` 的 `Cached` | 长期 < 1GB = 缓存被挤干，SMB 会变慢 |

**兜底建议**：在 SSD 应用池上建 8GB swapfile，`vm.swappiness=10`。swap 不是扩容，只用于吸收峰值、避免 OOM 杀容器；同时给 memory-api / qdrant 设 `mem_limit`，让 OOM 优先命中容器而不是系统进程。
> UGOS 升级可能重置 `/etc/fstab` 与 sysctl，需确认持久化；不支持则退化为「严格错峰 + 不建 swap」。

- 内存有空槽，上限 96GB，**不支持 ECC**
- 记忆体的分项预算见 12.2；升级判据见 12.8

### 11.8 部署顺序

```
① Portainer（先有管理界面）
② Caddy（先有统一入口）
③ Gitea（先把代码管起来）
④ Redis（队列底座）
⑤ Uptime Kuma（能看见再说）
⑥ Qdrant（Phase 3 再上）
⑦ 记忆体全栈（PostgreSQL + memory API + Worker，见第十二章）
```

①②③④ 是地基，⑤⑥⑦ 随进度补。记忆体可以提前到 ④ 之后做。

---

## 十二、记忆体服务接入（Agent Memory）

> 自研模块：`opencode-extensions-main-agent-memory/agent-memory`
> 目标：从 MacBook M1 16GB 迁出，改为「NAS 跑有状态服务 + Studio 跑模型」。

### 12.1 组件与分工

| 组件 | 运行位置 | 理由 |
|---|---|---|
| PostgreSQL + pgvector | **NAS** | 有状态、常驻、数据量小（<1GB） |
| Redis（db0） | **NAS** | 队列 + 缓存 |
| Qdrant（`mem_*` collection） | **NAS** | 与视频流水线共用实例，collection 隔离 |
| memory API（FastAPI） | **NAS** | 对外只暴露 HTTP |
| memory Worker（Celery） | **NAS** | 做 enrichment / extraction，**不加载 reranker** |
| **Ollama（nomic-embed + qwen2.5:7b）** | **Studio** | i3 跑 7B 约 1~2 token/s，不可用 |
| MacBook | 只调 API | 零算力 |

**为什么 Ollama 必须放 Studio**：enrichment 每条记忆要生成 4~6 个问题，7B 在 i3 上一条要跑几分钟；embedding 也会拖慢写入。

### 12.2 资源预算（NAS 16GB）

| 组件 | 稳态 | `mem_limit` 上限 |
|---|---|---|
| PostgreSQL + pgvector | 0.6~1.0GB | 1.2GB |
| Redis | 0.4~0.8GB | 1GB |
| Qdrant（记忆集合） | 0.8~1.5GB | 2GB |
| memory API（含 reranker） | 3.3~3.8GB | 4GB |
| memory Worker（Celery 并发 2） | 0.3~0.6GB | 1GB |
| **记忆体小计** | **5.4~7.7GB** | **9.2GB** |

> 加上 11.7 的系统、Gitea、Caddy 等非记忆体部分（约 2~4GB），整机稳态约 8~12GB。
> **账面剩余 ~6GB 是理想值；扣除不可回收部分与峰值叠加，实际可调度余量约 3~4GB。**
> 16GB 够 Phase 1–2；Phase 3 上视频向量集合后见 11.7.2。

### 12.3 四条内存纪律（reranker 只有一份 + 容器总量封顶）

reranker（`bge-reranker-v2-m3`，fp32 ≈2.3GB + torch ≈1GB）最容易被复制成多份；总量封顶则是防止「每条都合规、加起来仍超」。以下四条必须同时满足：

| 纪律 | 配置 | 违反后果 |
|---|---|---|
| 只在 API 加载 | `worker: RERANK_ENABLED=false` | worker 每个子进程各加载一份 |
| uvicorn 单进程 | `--workers 1` | 4 个 worker = 多 9GB |
| Celery 并发 ≤2 | `--concurrency=2` + `mem_limit` | `concurrency=8` 直接 OOM |
| 全栈总量 | 各容器 `mem_limit` 之和 ≤ 12.5GB | 给系统和页缓存留 ≥3.5GB；超了就是拿系统进程赌 OOM |

**Compose 限额写法**（v2 非 Swarm 模式下 `deploy.resources` 会被忽略）：

```yaml
services:
  memory-api:
    mem_limit: 4g
    cpus: 2.0
  memory-worker:
    mem_limit: 1g
    cpus: 1.0
```

### 12.4 换机器必改的配置

| 键 | 本机（M1 妥协值） | 迁到 NAS 后 |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11435` | `http://studio:11434` |
| `ENRICHMENT_LLM_ENDPOINT` | `127.0.0.1:11435/...` | `studio:11434/v1/chat/completions` |
| `EMBED_KEEP_ALIVE` | `-1` | `300` |
| `RERANK_CANDIDATES_CE_MAX` | `10` | `10`（别调大） |
| Celery `--concurrency` | `1` | `2`（**不是默认建议的 8**） |
| `OLLAMA_NUM_PARALLEL` | — | `4`（Studio 侧） |

> `11435` 是本机 11434 被 relay 占用后的绕行口，**不是产品设计**。
> **`.env` 与 `.env.example` 两边一起改**，容器和宿主机读的不是同一份。

### 12.5 与视频流水线共用资源

| 资源 | 隔离方式 |
|---|---|
| Qdrant | collection 前缀：记忆 `mem_*`，视频 `clip_*` |
| Redis | DB 编号：`db0` 记忆 / `db1` 视频队列 / `db2` 个人开发 |
| Studio 内存 | 阶段切换的 `unload_all_models()` 一并卸载记忆用的 Ollama 模型 |
| 端口 | 记忆 API 用 `8010`，避开 Mac 上仍在跑的 `:8000` |

### 12.6 迁移步骤（Mac → NAS）

```
① NAS 起新实例，端口 8010，先不接客户端
② 数据迁移
   - Postgres：pg_dump → pg_restore
   - Qdrant：snapshot API
③ 验证：/health 200、写入一条、检索一次
④ Mac 客户端改指向 NAS
⑤ 观察 24h
⑥ 最后停 Mac 旧实例（:8000）
```

**顺序不能反**：先起新、再切客户端、最后停旧。

⚠️ **换 embedding 模型或改 `EMBED_DOC_PREFIX` → 必须 re-embed**，否则旧向量静默失效（不报错，检索质量直接掉）。
先跑 `scripts/reembed_ltm.py --dry-run` 看要重嵌多少。

### 12.7 监控指标

| 指标 | 阈值 | 怎么看 |
|---|---|---|
| NAS 可用内存 | 稳态 **> 4GB** | `free -m` |
| 内存压力 | `some avg10` < 10 | `/proc/pressure/memory` |
| swap 使用 | < 1GB 且能回落 | `free -m` |
| OOM | 0 次 | `dmesg` |
| 容器 CPU | 单容器 < 80% | `docker stats` |
| 检索 P95（含 rerank） | < 1.5s | API 日志 |
| SMB 10GB 拷贝 | 与装前差异 < 10% | 实测 |
| Qdrant 向量数 | < 50 万（16GB 未量化时） | Dashboard |

### 12.8 内存升级触发条件

**先取证，再买。** 满足任意一条即加一条 16GB（→32GB）：

1. `free -m` 的 `available` **连续 7 天 < 4GB**（不是某一刻）
2. `/proc/pressure/memory` 的 `some avg10` **> 10 持续 5 分钟**
3. swap `used` **> 1GB 且不回落**，或 `dmesg` 出现过 OOM kill
4. Qdrant 向量 **> 50 万**（未开量化 / `on_disk` 时）
5. 想加 Prometheus / Loki / 虚拟机
6. SMB 明显变慢且 `Cached` 长期 < 1GB（确认是页缓存不足）

**升级建议**：加一条 16GB（→32GB，300~400 元）即可，**不要一步上 96GB**。
内存更大 ≠ 能跑 AI，i3 的 CPU 瓶颈不会因为内存变大而消失；但 16→32GB 能一次性消掉 Qdrant 与备份窗口的叠加风险，是唯一值得的升级。

### 12.9 验收

| # | 项 | 标准 |
|---|---|---|
| 1 | `/health` | 200 |
| 2 | 写入 → 检索闭环 | 100 条记忆，召回与 Mac 上一致（±5%） |
| 3 | 检索 P95 | < 1.5s |
| 4 | NAS available | > 4GB |
| 5 | SMB 速度 | 与装前差异 < 10% |
| 6 | 断电恢复 | 容器自动拉起，无需人工 |
| 7 | 24h 满载压测 | 备份 + 媒体索引 + 100 次检索并发：无 OOM，swap 峰值 < 1GB |

---

## 十三、文件整理自动化（`kb`）

### 13.1 三档权限

| 档 | 范围 | 是否需要确认 |
|---|---|---|
| **A 自动** | pipeline 产物归档、日志轮转、`work/` 过期清理、临时文件 | 否 |
| **B 需确认** | 下载 / 截图 / 文档 / 散落代码的分类与移动 | 是 |
| **C 禁止自动** | 删除任何文件、移动 git 仓库、动 `.git` / `venv` / `node_modules` / 系统目录 / 隐私目录 | 永不 |

### 13.2 NAS 目录即真相

```
/Volume2/KexLabs/
├── 00_inbox/          # 待分类（临时落点）
├── 10_projects/       # 代码项目（与 Gitea 对应）
├── 20_media/          # 图片 / 视频 / 音频
├── 30_docs/           # 文档 / 合同 / 资料
├── 40_deliverables/   # 成片交付
├── 90_archive/        # 完结项目（YYYY/MM）
└── 99_trash/          # 待删（保留 30 天）
```

本地只留 active 工作副本。

### 13.3 `kb` 六个命令

```bash
kb scan                 # 扫描本地，生成分类提案
kb plan                 # dry-run：列出「哪个文件 → 去哪」
kb apply                # 执行（写 undo log）
kb undo <id>            # 一键回滚
kb report               # 整理报告
kb find <关键词>         # 查文件在哪
```

### 13.4 分类：规则优先，LLM 兜底

| 判断依据 | 用什么 |
|---|---|
| 扩展名 / 路径 / 修改时间 / 大小 | **规则**（覆盖约 80%，快且确定） |
| 「这个文件属于哪个项目」 | LLM |
| 重命名 / 写索引 / 生成 README | LLM |

**LLM 不决定「删不删」**——只做归类建议，执行由确定性代码完成。

示例规则：

```
.env* 且含 .bak / .pre / .stale / .rollback  → 保留最新 2 个，其余进 99_trash
*.png / *.jpg 且位于 Desktop                 → 20_media/screenshots/YYYY-MM/
> 1GB 的文件                                  → 只报告，不移动
```

### 13.5 代码整理

| 状态 | 处理 |
|---|---|
| Active 项目（≤3 个） | 留本地工作副本 |
| 已完结 | push Gitea → 归档 NAS → **你确认后**删本地 |
| 真相源 | **始终是 Gitea** |

**绝不自动 `git push`，也绝不自动删除本地仓库。**

### 13.6 五条安全底线

1. **dry-run 默认**，必须显式 `--apply`
2. **只移动不删除**（删除进 `99_trash`，30 天后清）
3. **每次操作写 undo log**，`kb undo` 一条命令回滚
4. **黑名单**：`.git/`、`venv/`、`node_modules/`、系统目录、隐私目录
5. **最近 24h 修改过的文件不动**

### 13.7 主动性：扫描自动，执行需确认

```
launchd 每天 02:00
  └─ kb scan → 生成提案（不执行）
        │
早上开 opencode
  └─ Agent 汇报：「昨晚扫到 47 个待整理文件，计划移动到 3 个位置，
                  有 2 个拿不准（附路径），要执行吗？」
        │
你说「执行」
  └─ kb apply → 出报告
```

### 13.8 验收

| # | 项 | 标准 |
|---|---|---|
| 1 | `kb plan` 输出 | 每个文件都有「来源 → 目标 → 理由」 |
| 2 | `kb apply` 后 | `kb undo` 能 100% 还原 |
| 3 | 黑名单 | 跑完 `.git` / `venv` 一个字节未变 |
| 4 | 误判率 | 抽检 20 个移动，错误 ≤ 1 |
| 5 | 空跑 | `kb plan` 连续两次结果一致 |

---

## 附：一句话原则

> **Phase 1 的目标不是「搭平台」，是「把一个镜头端到端跑通」。**
> 任何在这一步之前引入的服务（Celery / Qdrant / Agent 调度）都是在给自己加故障点；**Redis 例外**——它是队列底座，Phase 1 就要上（见 11.2）。
> I2V 型号由 Phase 0.5 实测决定，不要先用猜的写死（见 7.2）。
> Agent 编排在 Phase 2 之后引入——先让工具可靠，再让 Agent 接管（见 9.13）。

---

*文档版本：v4.2（Delivery-Ready · I2V · Memory · Housekeeping Edition）*
*所属机构：Kex Labs Studio*