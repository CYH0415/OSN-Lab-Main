# Task 4 Feature Engineering Report

## Summary

- Target column: `rating__north_america`
- Source task3 train rows: 1012
- Task4 train rows: 810
- Task4 validation rows: 202
- Task4 test rows: 253
- Raw feature columns: 165
- Encoded feature columns: 758
- Checkbox columns split as multi-hot: 32
- Categorical/radio columns encoded as one-hot: 133

## Leakage Guard

Only `category` and `answer__*` columns are used as model inputs. `sample_id`, `split`, and every `rating__*` column are excluded from `X_*` files.

## Label Mapping

- `Everyone` -> `0`
- `Everyone 10+` -> `1`
- `Teen` -> `2`
- `Mature 17+` -> `3`
- `Adults only 18+` -> `4`

## Known Data Caveats

- `Social or Communication` has very few samples, so category-specific conclusions for it should be conservative.
- Unseen validation/test answer values are ignored by the fitted encoder and recorded in `unseen_values.json`.
- Structural missing markers are preserved as explicit features: `__INACTIVE__`, `__NOT_APPLICABLE__`, `__NONE__`.

## Output Checks

- Train/validation/test feature columns are identical.
- Encoded matrices contain no missing values.
- Sparse `.npz` matrices and CSV matrices use the same feature order as `feature_names.csv`.
