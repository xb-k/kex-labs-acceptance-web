---
name: dev-cookbook
description: 全流程开发 cookbook（Master 与子 Agent 共用）—— 规格 → 计划 → 实现 → 验收 → 排障 → 交付 → 文档。任何 Slow Path 工程目标，在派发或动手前先按本 skill 定位阶段、产物与出口判据；L0 轻量工作只看 06-document，不套测试。
---

# 开发全流程 Cookbook（Master 与子 Agent 共用）

> **一本书，七个阶段。Master 和子 Agent 读同一份** —— 这是「dev 与验收各按各的理解做 → 好几轮才到需求」的根治。
> 阶段划分借 obra/superpowers；门禁套本机收敛五闸（skill `convergence-orchestration`）+ L0/L1/L2 分级。
> ⚠️ 只读**当前阶段**那一章（渐进式路由），**禁止**一次性通读七章。

## 0. 先分级（决定走哪几个阶段）

> 级别定义 / 判级口诀 / 派发目标 → **单一真相源**：skill `convergence-orchestration` §0.5。下表只列**各级走哪几个阶段**。

| 级别 | 走哪几个阶段 |
|---|---|
| **L0 轻量** | 只走 **⑦ 文档**；不冻结判据、不派验收、**不要求「测试通过」** |
| **L1 标准** | ③ 实现（含交前自测）；**跳过** ① 规格 与 ④ 验收 |
| **L2 重工程** | ① → ② → ③ → ④ 全走；排障类插 ⑤ |

## 1. 五条共用铁律（任何阶段都守）

1. **复现先于动手**：改 bug / 修性能前先**稳定重现**；重现不了 → **先补信息或判「已解决 / 不可复现」**，不许盲修。
   （本机可复现窗口见 ⑥；RPA 代操类复现见 skill `rpa-flow-fix`。）
2. **判据先于实现**：L2 动代码前先冻结可观测断言（`acceptance/<id>/spec.md`）与契约表（`acceptance/<id>/contract.md`，「输入 → 期望值」逐行），dev 工单原样带 `acceptance_criteria` / `contract_table`；无契约表的 L2 工单不得开工。判据含糊**当场报**，别等 FAIL。
3. **证据先于结论**：每个结论都要 `文件:行` / 日志路径 / exit code 兜底。**编造「已完成」是最严重的失败**。
4. **一次做对**：同一模块的连续微调、自检、收尾**并入同一工单**；禁止「改一行 / 搬文件 / 复核注释」各占一轮。
5. **同一份契约**：所有子 Agent 出口都是 Return Contract（**字段规范见 `~/.config/opencode/references/master/envelopes.md`**）。

## 2. 阶段路由（按需打开对应章）

| 阶段 | 何时进入 | 谁 | 章 |
|---|---|---|---|
| ① 规格 | 需求模糊 / L2 要判据 | `master` 派 `acceptance-tester`（用例先行） | `references/00-spec.md` |
| ② 计划 | 多文件 / 有依赖顺序 | `master`（+ `plan-dev`） | `references/01-plan.md` |
| ③ 实现 | 写 / 改代码 | `dev` / `plan-dev` / `task-runner` | `references/02-implement.md` |
| ④ 验收 | L2 / 跨层 / 用户可感知 | `acceptance-tester` | `references/03-verify.md` |
| ⑤ 排障 | 性能 / 事故 / 疑难 bug | `master` 派只读诊断工单 | `references/04-diagnose.md` |
| ⑥ 交付 | 收敛后（FAIL=0） | `master` | `references/05-ship.md` |
| ⑦ 文档 | L0 文档 / README / 配置 | `dev`（纯探查 `explore`） | `references/06-document.md` |

## 3. References Navigation（渐进式路由，禁通读）

- 需求模糊、要产出 `spec.md` / 冻结用例 → `references/00-spec.md`
- 拆工单、排依赖、登记 `TASK.md` → `references/01-plan.md`
- 动手写代码、交前自检 → `references/02-implement.md`
- 独立黑盒验收、判 PASS/FAIL/BLOCKED → `references/03-verify.md`
- 先找根因再一把修 → `references/04-diagnose.md`
- 收敛后交付、更新看板、汇报 → `references/05-ship.md`
- 写文档 / README / 配置（L0，不套测试） → `references/06-document.md`

## 4. 与其它 skill 的关系

- 调度层的**收敛五闸**（合并 / 判据先行 / 根因优先 / 收尾止损 / 禁轮询）→ skill `convergence-orchestration`。
- 白盒代码审查（规范 / 需求 / **影响面·契约**）→ agent `reviewer`（与 ④验收**并行**的独立审查；触发条件见 convergence 闸二附则）。
- RPA 代操异常排查 → skill `rpa-flow-fix`（领域专用，优先）。
- 具体工程手法（tdd / code-review / diagnosing-bugs / resolving-merge-conflicts）→ 见 `~/.config/opencode/references/dev/skills-catalog.md`。
