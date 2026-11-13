---
name: script-historical-grounding
description: "【平台核心技能】Google Search 实时历史史实核验规范 —— 针对历史剧/小说长故事自动检索朝代纪年、服饰官制、器物建筑礼仪，防止穿越穿帮。"
license: internal
---

# 历史题材与小说长故事史实考据规范

配合工作台「剧本编辑器 · 小说历史模式」运行：
1. 生成分场前，自动触发 `@google/genai` `googleSearch` 工具执行一手历史背景检索。
2. 提取朝代确切纪年、服饰形制、日常器皿饮食及建筑规制要点（`historical_context`）与参考来源链接（`historical_sources`）。
3. 将经核验的历史特征硬性注入 I2V 英文生视频提示词，避免现代工业品、错代家具与误用典故出现。
