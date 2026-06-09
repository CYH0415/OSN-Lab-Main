# Google Play IARC 问卷逆向研究日志

更新时间：2026-06-09

## 当前结论

当前只保留最后一次三分类全量遍历结果，输出目录为：

- `data_categories/`

已清理此前的中间输出目录，包括 `data`、`data_smoke`、`data_graph_test`、`data_full`、`data_dfs_smoke*`、`data_categories_smoke`。

## 已完成的数据

三类 IARC Category 均已完整遍历并保存：

| Category | 目录 | 问题数 | 图边数 | 树边数 | 状态数 | 根问题数 | 冲突数 | skipped probes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Game | `data_categories/game/` | 91 | 81 | 223 | 50 | 14 | 0 | 0 |
| Social or Communication | `data_categories/social_or_communication/` | 12 | 5 | 24 | 4 | 7 | 0 | 0 |
| All Other App Types | `data_categories/all_other_app_types/` | 115 | 112 | 269 | 59 | 9 | 0 | 0 |

每个分类目录内保留：

- `questionnaire_tree.json`：遍历原始记录，包含状态、探测边、路径信息。
- `questionnaire_tree.md`：树结构 Markdown 摘要。
- `question_graph.json`：规范化后的问题图，问题选项下直接保存子问题 id。
- `question_graph.md`：问题图 Markdown 摘要。
- `question_graph.html`：单分类可视化预览页面。

总览文件：

- `data_categories/manifest.json`：三分类索引。
- `data_categories/index.html`：三分类树预览入口。

预览入口：

```text
http://127.0.0.1:8765/data_categories/index.html
```

## 当前脚本

主要脚本：

- `scripts/inspect_questionnaire.mjs`
  - 连接 Chrome/Play Console 页面。
  - 选择 IARC Category。
  - 用 DFS 回溯遍历问卷。
  - 输出 `questionnaire_tree.*` 和 `question_graph.*`。
- `scripts/inspect_all_categories.mjs`
  - 自动读取可选 Category。
  - 对每个 Category 调用 `inspect_questionnaire.mjs`。
  - 写入 `data_categories/manifest.json`。
- `scripts/render_question_graph.mjs`
  - 将单个 `question_graph.json` 渲染为可视化 HTML。
- `scripts/render_category_index.mjs`
  - 将 `data_categories/manifest.json` 渲染为三分类总览入口。

package scripts：

```bash
npm run inspect:questionnaire
npm run inspect:categories
npm run render:graph
npm run render:category-index
```

## 关键实现选择

遍历方式已经改为正常 DFS 回溯：

- 每个问题只在它当前可见、且处于当前 DFS scope/frontier 时探测。
- 对一个问题，逐个选择其选项，观察新增/移除的问题，从而确定该选项的子问题。
- 避免旧实现反复从根问题重放、跨层误连、probe 越跑越慢的问题。

问题 key 采用稳定签名：

- 不再依赖完整 `innerText`。
- 当前 key 由问题类型、问题文本、选项集合等稳定信息生成。
- 这样同一个问题不会因为子问题显隐变化而变成多个不同 id。

图数据结构：

- `question_graph.json` 中每个 question 有自己的 `options`。
- 每个 option 下保存 `children: [questionId, ...]`。
- 子问题使用 id 引用，不直接内嵌完整对象，避免重复、循环引用和后续更新困难。

复选框特殊处理：

- 对默认选中的 checkbox，探测 `false` 产生的 removed children 会映射回该 checkbox option 的子问题。
- 这修复了类似 “Scary elements -> How frequent are the scary elements?” 这类子问题归属错误。

Radio 恢复限制：

- 原生 radio 选中后无法回到未选状态。
- 脚本允许部分可见状态等价恢复；必要时会丢弃草稿并从分类入口重建当前 DFS 父状态。

## Play Console / Chrome 前提

需要使用有权限的 Google 账号：

```text
mengshu0715@gmail.com
```

推荐通过已登录的 Chrome CDP 会话运行：

```bash
EXPECTED_GOOGLE_ACCOUNT="mengshu0715@gmail.com" \
CDP_URL="http://127.0.0.1:9222" \
CATEGORY_OUT_ROOT=data_categories \
npm run inspect:categories
```

注意：

- 不要在无准备时重新跑全量遍历；它会操作 Play Console 问卷页面，并可能丢弃未保存草稿。
- 当前研究目标是读取问卷结构，不应点击最终提交或保存会产生外部副作用的结果。

## 已知可视化状态

总览页 `data_categories/index.html` 已可切换三类 Category。

单分类图页支持：

- 缩放节点。
- 搜索/查看节点。
- 选中节点高亮。
- 展示 option 到 children 的关系。

后续如要继续优化可视化，优先关注：

- 大图布局密度。
- option 标签靠近对应子问题。
- 跨层边的可读性。
- 从问题顺序、父子顺序保证自动填写脚本稳定执行。

## 下一步建议

1. 基于 `question_graph.json` 设计答案组合采样策略。
2. 明确每个分类需要采集的样本数与覆盖目标。
3. 编写自动填写脚本时，直接消费 `question_graph.json`，按页面可见顺序和 option children 关系生成路径。
4. 对每个采样路径执行填写、Next、读取评级结果，保存输入路径和输出 rating。
