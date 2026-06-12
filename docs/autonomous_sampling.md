# Autonomous Rating Sampling

`scripts/autonomous_rating_sampler.mjs` runs a complete sampling loop without using the old structural or hand-written balanced samples.

It reads only:

- `data_categories/*/question_graph_risk_annotated.json`
- The results collected in its own output directory

The loop performs:

1. Generate legal candidates from graph parent-option dependencies.
2. Reject radio conflicts and unreachable question paths.
3. Balance the next batch by category, primary content tag, and predicted age band.
4. Fill the Play Console questionnaire and parse real ratings.
5. Update predictions from results collected by this run.
6. Retry failures and continue until `TARGET_SAMPLES` successful samples exist.

## Run

Start Chrome with remote debugging and the `mengshu0715@gmail.com` Play Console session, then run:

```bash
TARGET_SAMPLES=1000 \
BATCH_SIZE=24 \
EXPECTED_GOOGLE_ACCOUNT="mengshu0715@gmail.com" \
IARC_CONTACT_EMAIL="mengshu0715@gmail.com" \
npm run sample:autonomous
```

The command is resumable. Running it again with the same `AUTONOMOUS_OUT_DIR` continues from its checkpoint.

Generate and inspect candidates without touching Play Console:

```bash
AUTONOMOUS_OUT_DIR=rating_artifacts/autonomous/rating_autonomous_preview \
CANDIDATE_POOL_SIZE=12000 \
npm run sample:autonomous:generate
```

## Outputs

- `rating_artifacts/autonomous/rating_autonomous/dataset.jsonl`: self-contained training samples with answers, risk metadata, and ratings.
- `rating_artifacts/autonomous/rating_autonomous/results.jsonl`: raw successful runner results.
- `rating_artifacts/autonomous/rating_autonomous/candidates.jsonl`: generated candidate pool.
- `rating_artifacts/autonomous/rating_autonomous/selected.jsonl`: selection history.
- `rating_artifacts/autonomous/rating_autonomous/attempts.json`: retry checkpoint.
- `rating_artifacts/autonomous/rating_autonomous/summary.json`: live distribution and progress.
- `rating_artifacts/autonomous/rating_autonomous/runner/errors.jsonl`: recoverable execution errors.

Use a new `AUTONOMOUS_OUT_DIR` for a completely independent dataset.
