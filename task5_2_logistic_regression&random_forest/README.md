# 任务 5.2：逻辑回归与随机森林

本目录用于补充北美年龄分级预测任务中的两个对比模型：

- `Logistic Regression`
- `Random Forest`

本任务的目标是，在 `Task 5.1` 已有的 `LightGBM / XGBoost` 基础上，再增加两个常见机器学习模型，完善模型对比实验，同时保持本目录内文件自包含，避免影响其他任务目录。

> 📊 **分析报告**: 详见 [analysis.ipynb](analysis.ipynb) — 包含模型性能对比、各类别 F1 分析、混淆矩阵。

## 目录构成

```text
task5_2_logistic_regression&random_forest/
├── train_models.py                 # ★ 主脚本：硬编码最优超参数，训练 + 评估
├── analysis.ipynb                  # 📊 分析 notebook
├── README.md                       # 本文档
├── requirements.txt                # Python 依赖
│
└── output/                         # 所有输出
    ├── metrics.json                # 模型参数与评估指标
    ├── model_comparison.csv        # 两模型在 val/test 上的指标汇总
    ├── classification_report_*.csv # 各类别 precision/recall/f1
    └── confusion_matrix_*.csv/png  # 混淆矩阵数据与热力图
```

| 文件/目录 | 说明 |
|-----------|------|
| `train_models.py` | **主脚本**。最优超参数已硬编码，直接训练并输出结果到 `output/` |
| `output/` | 所有模型输出 |
| `analysis.ipynb` | 分析 notebook，从 `output/` 加载结果生成图表和结论 |

## 数据来源

训练脚本直接读取 `Task 4` 特征工程阶段的输出文件：

- `../task4_feature_engineering/output/X_train.npz`
- `../task4_feature_engineering/output/X_val.npz`
- `../task4_feature_engineering/output/X_test.npz`
- `../task4_feature_engineering/output/y_train.csv`
- `../task4_feature_engineering/output/y_val.csv`
- `../task4_feature_engineering/output/y_test.csv`
- `../task4_feature_engineering/output/label_mapping.json`
- `../task4_feature_engineering/output/class_weights.json`

默认预测目标为：

```text
rating__north_america
```

也就是 Google Play / ESRB 的北美年龄分级结果。

## 运行方式

在仓库根目录执行：

```powershell
python "task5_2_logistic_regression&random_forest/train_models.py"
```

## 模型超参数

以下最优参数通过网格搜索确定，已硬编码在 `scripts/train_models.py` 中：

### 逻辑回归

| 参数 | 最优值 | 说明 |
|------|--------|------|
| `l1_ratio` | 1.0 | L1 正则化，自动特征选择（稀疏解） |
| `C` | 10.0 | 弱正则化，允许更大的特征权重 |
| `tol` | 1e-4 | 严格收敛容差 |
| `solver` | saga | 支持 L1 + 大数据量 |
| `max_iter` | 5000 | 充足迭代次数 |
| `class_weight` | balanced | 处理类别不均衡 |

**搜索空间**：53 种组合（L1/L2/ElasticNet × C ∈ [0.01, 10] × tol）

### 随机森林

| 参数 | 最优值 | 说明 |
|------|--------|------|
| `n_estimators` | 500 | 树的数量 |
| `max_depth` | None | 不限深度，充分生长 |
| `min_samples_leaf` | 1 | 允许叶节点只有 1 样本 |
| `max_features` | 0.3 | 每棵树随机采样 30% 特征 |
| `min_samples_split` | 2 | 2 样本即可分裂 |
| `class_weight` | balanced | 处理类别不均衡 |

**搜索空间**：162 种组合（n_estimators × max_depth × min_samples_leaf × max_features × min_samples_split 的交叉网格）

## 最终结果

| 模型 | Split | Accuracy | Macro F1 | Weighted F1 | Macro AUC |
|------|-------|:--------:|:--------:|:-----------:|:---------:|
| Logistic Regression | val | 0.936 | 0.928 | 0.937 | 0.973 |
| Logistic Regression | test | **0.921** | **0.918** | **0.921** | **0.977** |
| Random Forest | val | 0.812 | 0.811 | 0.810 | 0.955 |
| Random Forest | test | 0.783 | 0.797 | 0.785 | 0.945 |

逻辑回归在此任务上显著优于随机森林——高维稀疏 TF-IDF 特征天然适合 L1 正则化的线性模型。
