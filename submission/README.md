# Submission Package: Black-Box Reverse Modeling of Google Play Age Rating

This submission package contains all deliverables for the Social Privacy Networks course project on reverse modeling the Google Play age rating questionnaire as a black box.

## Structure of the Submission Package

The package is organized into three main directories:

*   **`report/`**: Contains the final experiment reports and assets.
    *   `report.pdf`: Complete course project report in Chinese (27 pages).
    *   `report_en.pdf`: Complete course project report in English (27 pages).
    *   `report.tex` & `report_en.tex`: LaTeX source codes.
    *   `figures/`: Graphical elements and topological figures referenced in the reports.
*   **`code/`**: Contains all source code scripts, feature building pipelines, and training pipelines.
    *   `scripts/`: Node.js and Playwright automation scripts for questionnaire structure inspection and automated crawlers.
    *   `task3_data_cleaning/`: Python cleaning script, data verification, and cleaning report.
    *   `task4_feature_engineering/`: Feature encoding scripts, multi-hot parser, and target mappings.
    *   `task5_1_lightgbm&xgboost/`: Boosting models training and parameter search notebooks.
    *   `task5_2_logistic_regression&random_forest/`: Logistic Regression & Random Forest training scripts, metrics, and pre-trained joblib models.
    *   `package.json` & `README.md`: Code dependencies and description.
*   **`data/`**: Contains all collected raw data, category trees, and processed final datasets.
    *   `dataset_v2/`: Cleaned and validated dataset version 2 containing 1,265 samples (split deterministically 80/20 into train/test splits), schemas, and coverage reports.
    *   `data_categories/`: Category questionnaires' dynamic trees (`game`, `social_or_communication`, `all_other_app_types`) and visual HTML trees.
    *   `rating_artifacts/`: Raw collected Crawling records, attempts check-pointer, and selection queues.

## Key Results Summary

*   **Dataset size**: 1,265 valid samples after semantic deduplication and validation.
*   **Feature dimensions**: 758 features encoded from 165 raw question inputs.
*   **Best Model**: **L1-regularized Logistic Regression** (SAGA solver) achieving:
    *   **Test Accuracy**: `0.921`
    *   **Test Macro F1-score**: `0.918`
    *   **Test Macro One-vs-Rest AUC**: `0.977`
*   **Core Findings**:
    1. Google Play ratings can be reverse predicted with high accuracy.
    2. High-dimensional sparse one-hot encoded inputs are ideal for L1-regularized linear models, which outperform decision trees (Random Forest, LightGBM, XGBoost) on smaller sample sets.
    3. High-risk signals (Blood/Gore, Nudity/Sex, Drugs, and Cash Gambling) are the dominant factors driving ratings.
    4. Bypassed sub-questions (structural missingness, `__INACTIVE__`) are highly informative features indicating low risk and should not be imputed.

## Replication Guide

Please refer to the README in the `code/` directory for setup instructions. In short:

1. Install Node dependencies: `npm install`
2. Connect to a remote debugging Chrome instance and run structure inspection:
   ```bash
   CDP_URL="http://127.0.0.1:9222" npm run inspect:questionnaire
   ```
3. Run crawls to collect rating results:
   ```bash
   CDP_URL="http://127.0.0.1:9222" npm run run:samples
   ```
4. Build and clean dataset:
   ```bash
   npm run build:dataset-v2
   ```
5. Build sparse encoded features:
   ```bash
   python task4_feature_engineering/scripts/build_features.py
   ```
6. Train models:
   ```bash
   python task5_2_logistic_regression&random_forest/train_models.py
   ```
