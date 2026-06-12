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
npm run smoke:rating
```

## 自动化评级 smoke 进展

已新增 `scripts/smoke_rating_automation.mjs`，用于验证 “选择分类 -> 填写 baseline 问卷 -> Save -> Next -> 读取 Summary 评级结果” 的可用性。

当前已用 `All Other App Types` baseline 跑通真实 smoke：

- 输出：`rating_artifacts/smoke/rating_smoke/baseline_all_other_app_types.json`
- Category：`All Other App Types`
- 填写策略：所有 Yes/No radio 选 `No`，checkbox 全 false。
- 结果页：已进入 Summary。
- 结构化评级解析：已成功抽取 7 个 territory。

baseline 评级结果：

| Territory | Authority | Rating | Content descriptors |
| --- | --- | --- | --- |
| Brazil | Classificação Indicativa (ClassInd) | All ages | - |
| North America | Entertainment Software Rating Board (ESRB) | Everyone | - |
| Europe | Pan-European Game Information (PEGI) | PEGI 3 | - |
| Germany | Unterhaltungssoftware Selbstkontrolle (USK) | USK: All ages | - |
| Rest of world | IARC Generic | Rated for 3+ | - |
| Russia | Google Play | Rated for 3+ | - |
| South Korea | Google Play | Rated for 3+ | - |

运行 smoke：

```bash
EXPECTED_GOOGLE_ACCOUNT="mengshu0715@gmail.com" \
CDP_URL="http://127.0.0.1:9222" \
IARC_CATEGORY="All Other App Types" \
OUT_DIR="rating_artifacts/smoke/rating_smoke" \
SUBMIT_FOR_RATING=1 \
npm run smoke:rating
```

注意：

- `SUBMIT_FOR_RATING=1` 会点击 Save/Next，把当前问卷答案发送给 Play Console 计算评级。
- 如果答案和已保存草稿一致，Play Console 的 Save 按钮可能 disabled；脚本会跳过 Save，直接点击 Next。
- 当前 smoke 只验证 baseline，不负责消费 `question_graph.json` 生成任意采样路径。

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

## 结构样本采集进展

已将结构样本生成策略从“每个分类总数上限”改为“每个探测策略独立上限”：

- `single_factor`：全量保留。
- `pairwise`：通过 `PAIRWISE_PER_CATEGORY` 单独控制。
- 当前生成参数：`PAIRWISE_PER_CATEGORY=600`。

当前样本文件：

- `rating_artifacts/samples/rating_samples/structural_samples.jsonl`
- 总样本数：1959

生成分布：

| Category | baseline | single_factor | pairwise | total |
| --- | ---: | ---: | ---: | ---: |
| Game | 1 | 223 | 600 | 824 |
| Social or Communication | 1 | 24 | 240 | 265 |
| All Other App Types | 1 | 269 | 600 | 870 |

当前成功采集结果：

- 结果文件：`rating_artifacts/results/rating_results_structural_v2/results.jsonl`
- 错误文件：`rating_artifacts/results/rating_results_structural_v2/errors.jsonl`
- 成功结果：1528
- 错误事件：75

成功结果分布：

| Category | baseline | single_factor | pairwise | total |
| --- | ---: | ---: | ---: | ---: |
| Game | 1 | 223 | 579 | 803 |
| Social or Communication | 1 | 24 | 240 | 265 |
| All Other App Types | 1 | 249 | 210 | 460 |

当前评级分布仍显示：

- `Social or Communication` 的 baseline 即触发部分地区较高下限：
  - Europe: `Parental guidance`
  - Germany: `USK: Ages 16+`
  - Rest of world / Russia / South Korea: `Rated for 12+`
- `Game` 和 `All Other App Types` 当前多数结构样本仍为低龄 baseline：
  - Europe: `PEGI 3`
  - Germany: `USK: All ages`
  - Rest of world / Russia / South Korea: `Rated for 3+`

错误类型概览：

| Error class | Count |
| --- | ---: |
| No ratings parsed from Summary page | 50 |
| Recovery/navigation issue | 14 |
| Timeout / modal overlay | 8 |
| Generated pairwise child not visible | 2 |
| Could not set generated answer | 1 |

重要结论：

- 继续盲跑 All Other 的剩余 pairwise 收益下降，因为已经出现“合并后子问题不可见”的真实样本生成问题。
- 下一步应修 pairwise 生成器：不能只检查同一 radio 问题选项冲突，还要验证两个 atomic path 合并后，每个 answer 的父依赖在前序答案中仍被满足。

## 2026-06-10 平衡采样进展

本轮新增并完成 35 个语义引导的补充样本：

| Category | 新增成功样本 |
| --- | ---: |
| Game | 9 |
| Social or Communication | 3 |
| All Other App Types | 23 |

新增覆盖主题包括：

- 位置共享。
- 数字商品、随机物品、现金奖励、下注、NFT。
- 目录中的性内容、语言、毒品内容。
- 年龄限制商品或活动推广。
- 浏览器、搜索、新闻、教育类应用。
- 不同程度的粗俗幽默和人体排泄内容。

同时补跑了 6 个历史失败样本。当前平衡探索结果去重后为：

- 成功样本：120。
- 未解决错误：0。
- Game：50。
- Social or Communication：7。
- All Other App Types：63。

主要修正：

1. 现金奖励后的下注题改为沿对应 checkbox option 的 `children` 选择，避免误连到 Bingo 或赌场分支中的同名问题。
2. Questionnaire 保存后不再使用固定短等待；脚本会等待保存状态稳定。
3. 如果第一次 `Next` 被保存过程吞掉，脚本会确认仍在问卷页并自动重试。
4. 按钮查找使用精确名称，减少页面中相似文本造成的误点击。

结果汇总文件：

- `rating_artifacts/manifests/rating_results_balanced_summary.json`

当前主要年龄段均已有样本：

- Europe：PEGI 3、7、12、16、18，以及 Parental guidance。
- North America：Everyone、Everyone 10+、Teen、Mature 17+、Adults only 18+。
- Germany：All ages、6+、12+、16+、18+。
- Rest of world：3+、7+、12+、16+、18+。

值得继续关注：

- 当前 120 个样本适合验证策略和训练数据格式，但对每个“年龄分级 × 内容类型”单元的数量仍不均衡。
- 下一阶段应基于结果缺口做目标配额采样，而不是继续按风险分值单向增加样本。
- Social 分类的问卷较短，分类本身会造成部分地区的年龄下限，不能与 Game、All Other 使用同一目标分布。
