# Rating Artifacts

Generated and historical age-rating artifacts are grouped by purpose:

- `samples/`: generated questionnaire sample queues (`rating_samples*`).
- `results/`: collected questionnaire results (`rating_results*`).
- `autonomous/`: autonomous sampler state and output.
- `smoke/`: smoke-test and recovery-test output.
- `work/`: temporary or replayable processing workspaces.
- `manifests/`: cross-run summaries and artifact inventories.

The original directory names are intentionally preserved inside these groups. They are stable
logical source identifiers used by Dataset V2 provenance, conflict records, and debug evidence.

Scripts use these defaults through `scripts/rating_artifact_paths.mjs`. The top-level location can
be overridden with `RATING_ARTIFACT_ROOT`; individual roots can be overridden with
`RATING_SAMPLE_ROOT`, `RATING_RESULT_ROOT`, `RATING_AUTONOMOUS_ROOT`, `RATING_SMOKE_ROOT`,
and `RATING_WORK_ROOT`.

Historical `run_config.json` files record how each run was originally launched. Current scripts
and documentation use the reorganized paths.

The project research log is maintained at `docs/research_log.md`.
