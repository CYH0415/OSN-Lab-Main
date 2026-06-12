# Dataset V2

Dataset V2 separates model-ready data from browser debugging evidence.

## Build and validate

```bash
npm run build:dataset-v2
npm run validate:dataset-v2
```

Set `DATASET_V2_OUT_DIR` to write to another directory.

## Coverage-driven sampling

Generate a batch that prioritizes low-frequency explicitly selected options:

```bash
COVERAGE_SAMPLE_LIMIT=80 \
COVERAGE_TARGET_COUNT=6 \
COVERAGE_MAX_ANSWERS=10 \
npm run generate:coverage-samples
```

Run the generated batch with `scripts/run_rating_samples.mjs`, then rebuild Dataset V2. The selector excludes completed answer signatures and Social samples by default. Override categories with `COVERAGE_CATEGORIES`.

For options that are absent from the autonomous candidate pool, generate reachable states directly from the question graph:

```bash
GAP_SAMPLE_LIMIT=220 \
GAP_MAX_CURRENT_COUNT=5 \
GAP_SINGLETON_VARIANTS=3 \
npm run generate:gap-fill-samples
```

This generator uses activation paths plus independent questionnaire contexts, excludes semantic states already present in Dataset V2, and does not target Social by default.

Use complete selected-option frequency when balancing model inputs:

```bash
GAP_COVERAGE_MODE=selected \
GAP_TARGET_COUNT=6 \
GAP_MAX_CURRENT_COUNT=5 \
npm run generate:gap-fill-samples
```

`selected` counts the option actually present in the complete questionnaire state. The default `target` mode counts only options explicitly requested by a sampling strategy; it is useful for auditing sampling intent, but it can make common baseline `No` answers appear artificially rare.

## Files

- `samples.jsonl`: semantically deduplicated samples with complete active questionnaire state and compact ratings.
- `debug_evidence.jsonl`: raw rating blocks and page text retained for audits.
- `failures.jsonl`: runner failure events.
- `validation_quarantine.jsonl`: rows excluded because Summary category evidence or the category-specific territory set did not match the submitted sample.
- `rating_conflicts.jsonl`: questionnaire states that produced inconsistent ratings and were excluded from the primary dataset.
- `coverage_report.json`: category, rating, option-frequency, duplicate, and conflict statistics.
- `schema.json`: primary record shape.

## State provenance

- `browser_snapshot`: captured from the rendered questionnaire immediately before Save/Next.
- `reconstructed_from_graph_and_baseline`: rebuilt from a V1 sample's explicit answers, its category graph, and the runner's baseline rule.

Reconstructed rows are useful for coverage analysis and migration, but browser snapshots are the preferred source for future samples. Training and evaluation splits should retain `provenance.stateSource` so reconstructed and directly observed states can be analyzed separately.

## Primary ratings

The primary dataset stores structured fields only: territory, authority, rating label, content descriptor text, interactive elements, and an optional warning. Original page text and raw rating blocks belong in `debug_evidence.jsonl`, not in model input by default.

The builder and validator require the Summary page category to match the sample category. Game samples must contain the ten expected rating territories; All Other App Types and Social or Communication samples must contain the seven common territories. Rows that fail these checks are excluded from `samples.jsonl`.
