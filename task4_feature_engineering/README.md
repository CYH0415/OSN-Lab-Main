# 任务4：特征工程与模型输入

本目录负责小组分工中的第 4 部分：把任务3清洗后的问卷宽表转换为模型训练可以直接读取的特征矩阵和标签文件。

任务4不会修改任务1、任务2、任务3的任何文件。所有输出都写入本目录的 `output/` 子目录。

## 目标

输入任务3产出的干净数据：

- `../task3_data_cleaning/output/train.csv`
- `../task3_data_cleaning/output/test.csv`
- `../task3_data_cleaning/output/column_groups.json`
- `../task3_data_cleaning/output/data_dictionary.csv`

输出任务5可直接使用的机器学习输入：

- 编码后的 `X_train / X_val / X_test`
- 标签文件 `y_train / y_val / y_test`
- 特征名称表
- 特征解释表
- 标签编码映射
- 类别权重
- 可复现的预处理元数据

默认预测目标是：

```text
rating__north_america
```

也就是 Google Play 返回的 North America / ESRB 年龄评级。

## 为什么默认预测 North America

任务3输出中有 10 个地区评级字段：

- `rating__australia`
- `rating__brazil`
- `rating__europe`
- `rating__germany`
- `rating__north_america`
- `rating__rest_of_world`
- `rating__russia`
- `rating__saudi_arabia`
- `rating__south_korea`
- `rating__taiwan`

这些字段都是同一次问卷的输出结果，不能互相作为输入特征，否则会造成目标泄漏。为了让任务5先完成一个清晰、可解释的多分类任务，本阶段默认只预测 `rating__north_america`，并排除所有 `rating__*` 字段。

North America 标签按年龄顺序编码为：

```json
{
  "Everyone": 0,
  "Everyone 10+": 1,
  "Teen": 2,
  "Mature 17+": 3,
  "Adults only 18+": 4
}
```

虽然标签具有年龄顺序，但任务5可以先按普通多分类问题训练模型，不必把它当作回归任务。

## 特征规则

任务4只使用以下输入特征：

- `category`
- 所有 `answer__*` 问卷答案字段

任务4明确排除：

- `sample_id`
- `split`
- 所有 `rating__*` 地区评级字段

编码方式如下：

| 原始字段类型 | 编码方式 | 说明 |
| --- | --- | --- |
| `category` | one-hot | 问卷类别，例如 Game / All Other App Types |
| radio 单选题 | one-hot | 每个合法答案取值生成一个 0/1 特征 |
| checkbox 复选题 | multi-hot | 按 ` || ` 拆分选项，每个选中项生成一个 0/1 特征 |
| 结构性缺失标记 | 显式保留 | `__INACTIVE__`、`__NOT_APPLICABLE__`、`__NONE__` 都会成为可学习特征 |

注意：编码词表主要来自任务3的 `data_dictionary.csv` 中记录的合法取值，而不是只依赖训练子集碰巧出现过的取值。这样可以避免稀有但合法的问卷答案因为训练/验证划分而缺少特征列。若后续数据中出现字典也没有记录的新答案，编码器会忽略该新值，不会报错；这些新值会记录在 `output/unseen_values.json`。

## 数据划分

任务3已经给出：

- `train.csv`
- `test.csv`

任务4保持任务3的 `test.csv` 不动，只从任务3的 `train.csv` 中再划分出验证集：

- task4 train：用于拟合编码器、训练模型
- task4 val：用于调参和模型选择
- task4 test：最终测试集，完全沿用任务3的 test

验证集划分规则：

- 分层字段：`category + rating__north_america`
- 验证集比例：`20%`
- 固定种子：`osn-lab2-task4-v1`
- 若某个分层只有 1 条样本，则保留在训练集中

## 安装依赖

如果当前 Python 环境还没有依赖，可以在本目录运行：

```powershell
pip install -r requirements.txt
```

需要的主要依赖：

- `pandas`
- `scikit-learn`
- `scipy`
- `joblib`

## 如何运行

在仓库根目录运行：

```powershell
python task4_feature_engineering/scripts/build_features.py
```

也可以进入本目录运行：

```powershell
cd task4_feature_engineering
python scripts/build_features.py
```

脚本运行成功后，会打印类似结果：

```json
{
  "valid": true,
  "targetColumn": "rating__north_america",
  "rows": {
    "task3_train_source": 1012,
    "task4_train": 810,
    "task4_val": 202,
    "task4_test": 253
  },
  "encodedFeatureColumns": 758
}
```

具体数字以实际输出为准。

可选参数：

```powershell
python task4_feature_engineering/scripts/build_features.py `
  --input-dir task3_data_cleaning/output `
  --output-dir task4_feature_engineering/output `
  --target-column rating__north_america `
  --validation-ratio 0.2 `
  --seed osn-lab2-task4-v1
```

默认参数已经适合当前项目，一般不需要手动修改。

## 输出文件说明

所有输出位于：

```text
task4_feature_engineering/output/
```

核心模型输入：

- `X_train.csv`：训练集特征矩阵，含 `sample_id` 和所有编码特征
- `X_val.csv`：验证集特征矩阵
- `X_test.csv`：测试集特征矩阵
- `y_train.csv`：训练集标签，含 `sample_id`、原始标签和数值标签
- `y_val.csv`：验证集标签
- `y_test.csv`：测试集标签

稀疏矩阵版本：

- `X_train.npz`
- `X_val.npz`
- `X_test.npz`

`.npz` 文件不包含 `sample_id`，列顺序与 `feature_names.csv` 完全一致。适合 sklearn 模型直接读取。

解释和元数据：

- `feature_names.csv`：特征列顺序，供 `.npz` 矩阵使用
- `feature_dictionary.csv`：每个编码特征对应的原始问题、选项、题型、适用类别和训练集出现次数
- `label_mapping.json`：标签到整数 ID 的映射
- `class_weights.json`：基于 task4 train 计算的 balanced 类别权重
- `split_distribution.csv`：train / val / test 的类别与标签分布
- `unseen_values.json`：验证集和测试集中训练阶段未见过的答案值
- `feature_engineering_metadata.json`：可复现的编码元数据
- `preprocessor.joblib`：保存给任务5复用的预处理元数据
- `feature_engineering_report.md`：本次构建的人类可读报告

## 任务5如何读取 CSV 版本

示例：

```python
import pandas as pd

X_train = pd.read_csv("task4_feature_engineering/output/X_train.csv")
y_train = pd.read_csv("task4_feature_engineering/output/y_train.csv")

sample_ids = X_train.pop("sample_id")
X = X_train
y = y_train["label_id"]
```

## 任务5如何读取稀疏矩阵版本

示例：

```python
import pandas as pd
from scipy import sparse

X_train = sparse.load_npz("task4_feature_engineering/output/X_train.npz")
y_train = pd.read_csv("task4_feature_engineering/output/y_train.csv")["label_id"]
feature_names = pd.read_csv("task4_feature_engineering/output/feature_names.csv")
```

稀疏矩阵更适合逻辑回归、线性 SVM、朴素贝叶斯等模型。

## 任务5建议

任务5至少训练 3 个模型。推荐从这 3 类开始：

1. 决策树或随机森林：方便解释规则和特征重要性。
2. 逻辑回归：作为稳定的线性 baseline。
3. XGBoost / LightGBM / Gradient Boosting：追求更高分类性能。

如果模型支持类别权重，建议使用 `class_weights.json` 或 `class_weight="balanced"`。

## 已知数据限制

当前数据总量为 1265 条，整体足够完成课程要求，但存在一个明显限制：

- `Social or Communication` 只有 16 条样本，其中测试集只有 3 条。

因此，报告中可以分析整体模型效果，以及 `Game`、`All Other App Types` 的规律；但对 `Social or Communication` 的类别级结论要谨慎。

## 复现注意事项

在 Windows 上，Git 可能把 `.jsonl` / `.csv` 文件从 LF 检出为 CRLF，导致任务3的哈希校验误报失败。这个问题不影响任务4读取 CSV 的内容，但如果需要严格复现 task3 的哈希验证，建议仓库后续增加 `.gitattributes` 固定数据文件换行符。

任务4脚本本身不会修改换行符设置，也不会改动 task3 文件。
