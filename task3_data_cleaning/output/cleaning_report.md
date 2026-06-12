# Task 3 Data Cleaning Report

Generated: 2026-06-12T08:51:36.769Z

## Result

- Source rows: 1265
- Additional rows excluded by task 3: 0
- Clean rows: 1265
- Train rows: 1012
- Test rows: 253
- Unified question columns: 164
- Category-question pairs represented: 218
- Rating label columns: 10

## Cleaning

The pipeline validates schema version, required fields, radio selections, explicit-answer
consistency, questionnaire-graph reachability, category-specific rating territories, duplicate
sample IDs, duplicate semantic questionnaire states, and conflicting rating labels. No
statistical imputation is performed.

`__INACTIVE__` means that a question belongs to the category but was not activated by the
selected branch. `__NOT_APPLICABLE__` means that the question or rating territory does not
apply to the category. An active checkbox with no selected option is represented as
`__NONE__`. The cleaned answer and rating columns contain no blank cells.

## Split

The split is a deterministic train/test = 80/20 holdout, stratified by questionnaire category and North
America/ESRB rating label.
Seed: `osn-lab2-task3-v1`.

Task 4 may create a validation set from `train.csv`; `test.csv` should remain untouched until
final evaluation. No one-hot encoding, category mapping, label encoding, resampling, or feature
selection is performed here.

All `rating__*` columns are targets. They must all be excluded from model features, including
when only one territory is selected as the prediction target; otherwise cross-territory labels
would cause target leakage. See `column_groups.json`.

## Source integrity

- samples.jsonl SHA-256: `A8F6B4E5097C8AB8275AF0ABCD21B09C73C497A5631A1A5F9DBE556F4E828FF7`
- Upstream validation quarantine rows: 30
- Upstream rating-conflict rows: 13
- Upstream failure events: 770
