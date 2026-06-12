# 任务3：数据清洗与数据集构建

## 成果概述

本目录对应小组分工中的任务3。任务1、2采集的原始问卷数据经过结构校验、去重、
缺失处理、异常筛选和字段统一后，形成了可复现的干净数据集。

当前结果包含1265条有效样本，其中：

- `train.csv`：1012条；
- `test.csv`：253条；
- 统一问卷答案字段：164列；
- 统一地区评级字段：10列；
- 任务3阶段新增排除记录：0条；
- 输出一致性验证错误：0项。

任务3的范围止于干净数据集和训练/测试集的构建，不包含特征编码、标签编码、类别
平衡、特征选择和模型训练。

## 输入数据

主要输入为：

`../dataset_v2/samples.jsonl`

辅助输入包括：

- `dataset_v2/schema.json`：样本结构定义；
- `dataset_v2/coverage_report.json`：上游数据覆盖和采集统计；
- `dataset_v2/validation_quarantine.jsonl`：上游结构异常记录；
- `dataset_v2/rating_conflicts.jsonl`：上游评级冲突记录；
- `dataset_v2/failures.jsonl`：上游采集失败事件记录；
- `data_categories/*/question_graph.json`：三个问卷类别的题目和分支结构。

输入样本分为三个问卷类别：

- `All Other App Types`；
- `Game`；
- `Social or Communication`。

## 已完成的数据处理

清洗过程包含以下内容：

- 校验样本版本、样本编号、问卷类别和必要字段；
- 校验单选题、复选题及显式答案的一致性；
- 根据问卷图检查活动分支，识别缺题或非活动题混入；
- 检查各问卷类别对应的评级地区是否完整；
- 按完整问卷状态识别重复样本；
- 对完全重复记录保留一条；
- 对相同问卷状态产生不同评级的记录整组排除；
- 将结构性缺失转换为明确的文本标记；
- 将嵌套 JSONL 展开为一行一个样本的 CSV；
- 统一样本、问卷答案和地区评级的字段名称；
- 按固定参数生成训练集和测试集；
- 保存清洗规则、源文件哈希、排除记录和数据分布。

当前 `samples.jsonl` 中的1265条记录全部通过任务3校验，因此任务3阶段没有新增排除
样本。上游隔离的30条类别异常记录和13条评级冲突记录保留在
`excluded_samples.csv` 中，用于审计。

## 数据表结构

`clean_dataset.csv`、`train.csv` 和 `test.csv` 均采用一行一个样本的宽表结构。
`train.csv` 与 `test.csv` 的字段完全一致，`clean_dataset.csv` 额外包含 `split`
字段。

主要字段类型如下：

- `sample_id`：样本唯一标识；
- `split`：样本所属数据集，仅存在于 `clean_dataset.csv`；
- `category`：原始问卷类别；
- `answer__<question_id>`：统一后的问卷答案字段；
- `rating__<territory>`：各地区返回的原始评级标签。

单选题保存被选中的原始选项文本。复选题存在多个选项时，以 ` || ` 连接。字段角色、
题目文本、题目类型、适用类别和允许值记录在 `column_groups.json` 与
`data_dictionary.csv` 中。

## 缺失值表示

任务3未使用均值、众数或其他统计插补。结构性缺失统一表示为：

- `__INACTIVE__`：题目属于当前类别，但该样本的问卷分支未激活此题；
- `__NOT_APPLICABLE__`：题目或评级地区不适用于当前类别；
- `__NONE__`：复选题已经激活，但没有选中任何选项。

Australia、Saudi Arabia 和 Taiwan 的评级只出现在 `Game` 类别中，其他类别对应的
评级字段为 `__NOT_APPLICABLE__`。当前输出中不存在非预期空白字段。

## 数据集划分

训练集和测试集采用确定性的分层留出划分：

- 分层依据：问卷类别与 North America 评级标签；
- 测试集比例：20%；
- 固定种子：`osn-lab2-task3-v1`；
- 训练集：1012条；
- 测试集：253条。

相同输入、测试比例和随机种子会产生相同的数据划分。

## 输出文件

全部成果位于 `output/`：

- `clean_dataset.csv`：1265条干净样本，包含 `split` 字段；
- `train.csv`：1012条训练样本；
- `test.csv`：253条测试样本；
- `data_dictionary.csv`：字段、题目、类型、允许值和缺失含义；
- `column_groups.json`：标识符、原始特征、原始目标及字段角色；
- `sample_metadata.csv`：样本类别、划分、采样策略和来源信息；
- `rating_details.csv`：各样本在不同地区的评级详细信息，共10754条；
- `excluded_samples.csv`：上游异常和评级冲突记录，共43条；
- `split_distribution.csv`：训练集和测试集的数据分布；
- `cleaning_report.json`：机器可读的清洗规则、统计和输入哈希；
- `cleaning_report.md`：便于阅读的清洗结果报告。

## 构建与验证

本目录的两个 npm 命令分别负责生成和验证成果：

```powershell
npm run build
npm run verify
```

默认输入目录为 `../dataset_v2`，默认输出目录为 `output`。

`npm run build` 根据当前输入重新生成全部输出文件；`npm run verify` 检查输出行数、
字段结构、源数据对应关系、缺失值、训练/测试划分和文件哈希。

当前验证结果为：

```text
valid: true
cleanRows: 1265
trainRows: 1012
testRows: 253
answerColumns: 164
ratingColumns: 10
errors: 0
```
