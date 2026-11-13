---
name: show-tasks
description: 查看当前项目的任务看板（Active & Pending Tasks）。当用户输入 /task、/tasks 或说“查看任务/当前进度”时触发。
---

# 1. References Navigation
- 任务看板路径：`.opencode/state/TASK.md`

# 2. Execution Flow
1. 使用 `read` 工具读取当前工程根目录下的 `.opencode/state/TASK.md`。
2. 提取并向用户清晰汇报：
   - 🎯 **当前与未完成任务 (Active & Pending Tasks)**
   - 🟢 **最近完成的任务 (Recently Completed)**
   - 📌 **下一步关键行动 (Next Actions)**
3. **铁律**：本技能为纯只读展示，严禁派发子任务，严禁修改任何代码。
