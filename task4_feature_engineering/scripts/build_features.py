#!/usr/bin/env python3
"""Build model-ready features from task3 cleaned questionnaire data.

The script is intentionally deterministic and does not modify task3 outputs.
It fits encoders on the task4 training subset only, then applies the same
feature columns to validation and test data. Rating columns are excluded from
features to avoid target leakage.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import warnings
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

warnings.filterwarnings(
    "ignore",
    message=r"Pandas requires version .*",
    category=UserWarning,
)

import joblib
import pandas as pd
from scipy import sparse
from sklearn.utils.class_weight import compute_class_weight


MISSING_SENTINELS = {"__INACTIVE__", "__NOT_APPLICABLE__", "__NONE__"}
CHECKBOX_SEPARATOR = " || "
DEFAULT_LABEL_ORDER = [
    "Everyone",
    "Everyone 10+",
    "Teen",
    "Mature 17+",
    "Adults only 18+",
]


@dataclass(frozen=True)
class FeatureSpec:
    name: str
    raw_column: str
    source_role: str
    question_id: str
    question_text: str
    question_type: str
    option_label: str
    applicable_categories: str
    is_missing_sentinel: bool


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Build task4 encoded features from task3 cleaned CSV files."
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=root / "task3_data_cleaning" / "output",
        help="Directory containing task3 output files.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=root / "task4_feature_engineering" / "output",
        help="Directory where task4 feature outputs will be written.",
    )
    parser.add_argument(
        "--target-column",
        default="rating__north_america",
        help="Rating column to encode as the prediction target.",
    )
    parser.add_argument(
        "--validation-ratio",
        type=float,
        default=0.2,
        help="Validation share carved out from task3 train.csv.",
    )
    parser.add_argument(
        "--seed",
        default="osn-lab2-task4-v1",
        help="Deterministic split seed.",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def stable_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("_")
    return value or "empty"


def unique_name(base: str, used: set[str]) -> str:
    name = base
    suffix = 2
    while name in used:
        name = f"{base}_{suffix}"
        suffix += 1
    used.add(name)
    return name


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def deterministic_validation_split(
    train_df: pd.DataFrame,
    target_column: str,
    validation_ratio: float,
    seed: str,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    strata = train_df["category"].astype(str) + " | " + train_df[target_column].astype(str)
    train_indices: list[int] = []
    val_indices: list[int] = []

    for _, group in train_df.assign(_stratum=strata).groupby("_stratum", sort=True):
        records = []
        for idx, row in group.iterrows():
            key = f"{seed}|{row['sample_id']}|{row['_stratum']}"
            records.append((stable_hash(key), idx))
        records.sort()

        n = len(records)
        if n <= 1:
            n_val = 0
        else:
            n_val = max(1, round(n * validation_ratio))
            n_val = min(n_val, n - 1)

        val_indices.extend(idx for _, idx in records[:n_val])
        train_indices.extend(idx for _, idx in records[n_val:])

    return (
        train_df.loc[sorted(train_indices)].reset_index(drop=True),
        train_df.loc[sorted(val_indices)].reset_index(drop=True),
    )


def load_metadata(input_dir: Path) -> tuple[dict[str, Any], pd.DataFrame, dict[str, dict[str, str]]]:
    column_groups = read_json(input_dir / "column_groups.json")
    dictionary = pd.read_csv(input_dir / "data_dictionary.csv", keep_default_na=False)
    dictionary_by_column = {
        row["column_name"]: row.to_dict()
        for _, row in dictionary.iterrows()
    }
    return column_groups, dictionary, dictionary_by_column


def split_checkbox_values(value: Any) -> list[str]:
    text = "" if pd.isna(value) else str(value)
    if text == "":
        return []
    if text in MISSING_SENTINELS:
        return [text]
    return [part.strip() for part in text.split(CHECKBOX_SEPARATOR) if part.strip()]


def split_allowed_values(value: Any) -> list[str]:
    text = "" if pd.isna(value) else str(value)
    return [part.strip() for part in text.split(CHECKBOX_SEPARATOR) if part.strip()]


def infer_feature_columns(
    column_groups: dict[str, Any],
    dictionary: pd.DataFrame,
    train_columns: list[str],
) -> tuple[list[str], list[str], list[str]]:
    raw_feature_columns = [
        col for col in column_groups["rawFeatureColumns"]
        if col in train_columns
    ]
    rating_columns = set(column_groups["rawTargetColumns"])
    feature_columns = [
        col for col in raw_feature_columns
        if col not in rating_columns and not col.startswith("rating__")
    ]
    if "category" not in feature_columns:
        feature_columns.insert(0, "category")

    checkbox_columns = set(
        dictionary.loc[
            (dictionary["question_type"] == "checkbox")
            & (dictionary["column_name"].str.startswith("answer__")),
            "column_name",
        ].tolist()
    )
    checkbox_features = [col for col in feature_columns if col in checkbox_columns]
    categorical_features = [col for col in feature_columns if col not in checkbox_columns]
    return feature_columns, categorical_features, checkbox_features


def build_specs(
    train_df: pd.DataFrame,
    categorical_features: list[str],
    checkbox_features: list[str],
    dictionary_by_column: dict[str, dict[str, str]],
) -> tuple[list[FeatureSpec], dict[str, list[str]], dict[str, list[str]], dict[str, Counter]]:
    specs: list[FeatureSpec] = []
    categorical_values: dict[str, list[str]] = {}
    checkbox_values: dict[str, list[str]] = {}
    feature_counts: dict[str, Counter] = {}
    used_names: set[str] = set()

    for col in categorical_features:
        meta = dictionary_by_column.get(col, {})
        values = split_allowed_values(meta.get("allowed_values", ""))
        if not values:
            values = sorted(train_df[col].astype(str).unique().tolist())
        observed_values = set(train_df[col].astype(str).unique().tolist())
        values = list(dict.fromkeys(values + sorted(observed_values - set(values))))
        categorical_values[col] = values
        feature_counts[col] = Counter(train_df[col].astype(str).tolist())
        role = "category" if col == "category" else "radio"
        for value in values:
            name = unique_name(f"{col}__{slugify(value)}", used_names)
            specs.append(FeatureSpec(
                name=name,
                raw_column=col,
                source_role=role,
                question_id=meta.get("question_id", ""),
                question_text=meta.get("description", ""),
                question_type=meta.get("question_type", "") if col != "category" else "category",
                option_label=value,
                applicable_categories=meta.get("applicable_categories", ""),
                is_missing_sentinel=value in MISSING_SENTINELS,
            ))

    for col in checkbox_features:
        counter: Counter = Counter()
        for value in train_df[col].tolist():
            counter.update(split_checkbox_values(value))
        meta = dictionary_by_column.get(col, {})
        values = split_allowed_values(meta.get("allowed_values", ""))
        observed_values = set(counter.keys())
        values = list(dict.fromkeys(values + sorted(observed_values - set(values))))
        checkbox_values[col] = values
        feature_counts[col] = counter
        for value in values:
            name = unique_name(f"{col}__{slugify(value)}", used_names)
            specs.append(FeatureSpec(
                name=name,
                raw_column=col,
                source_role="checkbox",
                question_id=meta.get("question_id", ""),
                question_text=meta.get("description", ""),
                question_type=meta.get("question_type", ""),
                option_label=value,
                applicable_categories=meta.get("applicable_categories", ""),
                is_missing_sentinel=value in MISSING_SENTINELS,
            ))

    return specs, categorical_values, checkbox_values, feature_counts


def encode_frame(
    df: pd.DataFrame,
    specs: list[FeatureSpec],
    categorical_values: dict[str, list[str]],
    checkbox_values: dict[str, list[str]],
) -> tuple[pd.DataFrame, dict[str, dict[str, int]]]:
    columns: dict[str, list[int]] = {}
    unseen: dict[str, Counter] = defaultdict(Counter)

    spec_by_col_option = {
        (spec.raw_column, spec.option_label): spec.name
        for spec in specs
    }

    for col, fitted_values in categorical_values.items():
        allowed = set(fitted_values)
        values = df[col].astype(str).tolist()
        for option in fitted_values:
            feature_name = spec_by_col_option[(col, option)]
            columns[feature_name] = [1 if value == option else 0 for value in values]
        for value in values:
            if value not in allowed:
                unseen[col][value] += 1

    for col, fitted_values in checkbox_values.items():
        allowed = set(fitted_values)
        row_sets = []
        for value in df[col].tolist():
            tokens = set(split_checkbox_values(value))
            row_sets.append(tokens)
            for token in tokens:
                if token not in allowed:
                    unseen[col][token] += 1
        for option in fitted_values:
            feature_name = spec_by_col_option[(col, option)]
            columns[feature_name] = [1 if option in tokens else 0 for tokens in row_sets]

    encoded = pd.DataFrame(columns, index=df.index, dtype="int8")
    unseen_summary = {
        col: dict(counter)
        for col, counter in sorted(unseen.items())
        if counter
    }
    return encoded, unseen_summary


def label_mapping(labels: list[str]) -> dict[str, int]:
    if set(labels).issubset(DEFAULT_LABEL_ORDER):
        ordered = [label for label in DEFAULT_LABEL_ORDER if label in set(labels)]
    else:
        ordered = sorted(set(labels))
    return {label: idx for idx, label in enumerate(ordered)}


def write_matrix_outputs(
    output_dir: Path,
    split_name: str,
    encoded: pd.DataFrame,
    labels: pd.Series,
    sample_ids: pd.Series,
    mapping: dict[str, int],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    encoded_with_id = encoded.copy()
    encoded_with_id.insert(0, "sample_id", sample_ids.tolist())
    encoded_with_id.to_csv(output_dir / f"X_{split_name}.csv", index=False, encoding="utf-8")

    sparse.save_npz(output_dir / f"X_{split_name}.npz", sparse.csr_matrix(encoded.values))

    y = pd.DataFrame({
        "sample_id": sample_ids.tolist(),
        "label": labels.astype(str).tolist(),
        "label_id": labels.astype(str).map(mapping).astype(int).tolist(),
    })
    y.to_csv(output_dir / f"y_{split_name}.csv", index=False, encoding="utf-8")


def distribution_rows(df: pd.DataFrame, split: str, target_column: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for value, count in sorted(Counter(df["category"].astype(str)).items()):
        rows.append({"split": split, "dimension": "category", "value": value, "count": count})
    for value, count in sorted(Counter(df[target_column].astype(str)).items()):
        rows.append({"split": split, "dimension": target_column, "value": value, "count": count})
    strata = df["category"].astype(str) + " | " + df[target_column].astype(str)
    for value, count in sorted(Counter(strata).items()):
        rows.append({"split": split, "dimension": "category_x_target", "value": value, "count": count})
    return rows


def main() -> None:
    args = parse_args()
    input_dir: Path = args.input_dir
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    train_source = pd.read_csv(input_dir / "train.csv", keep_default_na=False)
    test_df = pd.read_csv(input_dir / "test.csv", keep_default_na=False)
    column_groups, dictionary, dictionary_by_column = load_metadata(input_dir)

    if args.target_column not in train_source.columns:
        raise ValueError(f"Target column not found: {args.target_column}")

    feature_columns, categorical_features, checkbox_features = infer_feature_columns(
        column_groups,
        dictionary,
        train_source.columns.tolist(),
    )
    leakage_columns = [
        col for col in feature_columns
        if col.startswith("rating__") or col in {"sample_id", "split"}
    ]
    if leakage_columns:
        raise ValueError(f"Feature leakage columns detected: {leakage_columns}")

    task4_train_df, val_df = deterministic_validation_split(
        train_source,
        target_column=args.target_column,
        validation_ratio=args.validation_ratio,
        seed=args.seed,
    )

    labels = (
        task4_train_df[args.target_column].astype(str).tolist()
        + val_df[args.target_column].astype(str).tolist()
        + test_df[args.target_column].astype(str).tolist()
    )
    mapping = label_mapping(labels)

    specs, categorical_values, checkbox_values, feature_counts = build_specs(
        task4_train_df,
        categorical_features,
        checkbox_features,
        dictionary_by_column,
    )

    encoded_train, unseen_train = encode_frame(
        task4_train_df, specs, categorical_values, checkbox_values
    )
    encoded_val, unseen_val = encode_frame(
        val_df, specs, categorical_values, checkbox_values
    )
    encoded_test, unseen_test = encode_frame(
        test_df, specs, categorical_values, checkbox_values
    )

    if list(encoded_train.columns) != list(encoded_val.columns) or list(encoded_train.columns) != list(encoded_test.columns):
        raise RuntimeError("Encoded feature columns are not identical across train/val/test.")
    if encoded_train.isna().any().any() or encoded_val.isna().any().any() or encoded_test.isna().any().any():
        raise RuntimeError("Encoded feature matrix contains missing values.")

    write_matrix_outputs(
        output_dir, "train", encoded_train, task4_train_df[args.target_column], task4_train_df["sample_id"], mapping
    )
    write_matrix_outputs(
        output_dir, "val", encoded_val, val_df[args.target_column], val_df["sample_id"], mapping
    )
    write_matrix_outputs(
        output_dir, "test", encoded_test, test_df[args.target_column], test_df["sample_id"], mapping
    )

    feature_names = [{"feature_index": i, "feature_name": name} for i, name in enumerate(encoded_train.columns)]
    write_csv(output_dir / "feature_names.csv", feature_names, ["feature_index", "feature_name"])

    feature_dictionary_rows = []
    for i, spec in enumerate(specs):
        count = feature_counts.get(spec.raw_column, Counter()).get(spec.option_label, 0)
        feature_dictionary_rows.append({
            "feature_index": i,
            "feature_name": spec.name,
            "raw_column": spec.raw_column,
            "source_role": spec.source_role,
            "question_id": spec.question_id,
            "question_text": spec.question_text,
            "question_type": spec.question_type,
            "option_label": spec.option_label,
            "applicable_categories": spec.applicable_categories,
            "is_missing_sentinel": str(spec.is_missing_sentinel).lower(),
            "train_positive_count": count,
        })
    write_csv(
        output_dir / "feature_dictionary.csv",
        feature_dictionary_rows,
        [
            "feature_index",
            "feature_name",
            "raw_column",
            "source_role",
            "question_id",
            "question_text",
            "question_type",
            "option_label",
            "applicable_categories",
            "is_missing_sentinel",
            "train_positive_count",
        ],
    )

    class_labels = list(mapping.keys())
    class_weights_array = compute_class_weight(
        class_weight="balanced",
        classes=pd.Series(class_labels).to_numpy(),
        y=task4_train_df[args.target_column].astype(str).to_numpy(),
    )
    class_weights = {
        label: float(weight)
        for label, weight in zip(class_labels, class_weights_array)
    }
    write_json(output_dir / "label_mapping.json", {
        "target_column": args.target_column,
        "labels": mapping,
        "label_order_note": "Labels use ESRB age order when the known North America classes are present.",
    })
    write_json(output_dir / "class_weights.json", {
        "method": "sklearn balanced class_weight computed on task4 train split",
        "target_column": args.target_column,
        "class_weights": class_weights,
    })

    distribution = []
    distribution.extend(distribution_rows(task4_train_df, "train", args.target_column))
    distribution.extend(distribution_rows(val_df, "val", args.target_column))
    distribution.extend(distribution_rows(test_df, "test", args.target_column))
    write_csv(output_dir / "split_distribution.csv", distribution, ["split", "dimension", "value", "count"])

    unseen_summary = {
        "train": unseen_train,
        "val": unseen_val,
        "test": unseen_test,
    }
    write_json(output_dir / "unseen_values.json", unseen_summary)

    metadata = {
        "task": "task4_feature_engineering",
        "input_dir": str(input_dir.resolve()),
        "output_dir": str(output_dir.resolve()),
        "target_column": args.target_column,
        "validation_ratio": args.validation_ratio,
        "seed": args.seed,
        "source_hashes": {
            "task3_train_csv": sha256_file(input_dir / "train.csv"),
            "task3_test_csv": sha256_file(input_dir / "test.csv"),
            "task3_column_groups_json": sha256_file(input_dir / "column_groups.json"),
            "task3_data_dictionary_csv": sha256_file(input_dir / "data_dictionary.csv"),
        },
        "rows": {
            "task3_train_source": int(len(train_source)),
            "task4_train": int(len(task4_train_df)),
            "task4_val": int(len(val_df)),
            "task4_test": int(len(test_df)),
        },
        "columns": {
            "raw_feature_columns": len(feature_columns),
            "categorical_or_radio_columns": len(categorical_features),
            "checkbox_columns": len(checkbox_features),
            "encoded_feature_columns": int(encoded_train.shape[1]),
        },
        "feature_columns": feature_columns,
        "categorical_values": categorical_values,
        "checkbox_values": checkbox_values,
        "label_mapping": mapping,
        "missing_sentinels": sorted(MISSING_SENTINELS),
        "checkbox_separator": CHECKBOX_SEPARATOR,
    }
    write_json(output_dir / "feature_engineering_metadata.json", metadata)
    joblib.dump(metadata, output_dir / "preprocessor.joblib")

    report = [
        "# Task 4 Feature Engineering Report",
        "",
        "## Summary",
        "",
        f"- Target column: `{args.target_column}`",
        f"- Source task3 train rows: {len(train_source)}",
        f"- Task4 train rows: {len(task4_train_df)}",
        f"- Task4 validation rows: {len(val_df)}",
        f"- Task4 test rows: {len(test_df)}",
        f"- Raw feature columns: {len(feature_columns)}",
        f"- Encoded feature columns: {encoded_train.shape[1]}",
        f"- Checkbox columns split as multi-hot: {len(checkbox_features)}",
        f"- Categorical/radio columns encoded as one-hot: {len(categorical_features)}",
        "",
        "## Leakage Guard",
        "",
        "Only `category` and `answer__*` columns are used as model inputs. "
        "`sample_id`, `split`, and every `rating__*` column are excluded from `X_*` files.",
        "",
        "## Label Mapping",
        "",
    ]
    for label, idx in mapping.items():
        report.append(f"- `{label}` -> `{idx}`")
    report.extend([
        "",
        "## Known Data Caveats",
        "",
        "- `Social or Communication` has very few samples, so category-specific conclusions for it should be conservative.",
        "- Unseen validation/test answer values are ignored by the fitted encoder and recorded in `unseen_values.json`.",
        "- Structural missing markers are preserved as explicit features: `__INACTIVE__`, `__NOT_APPLICABLE__`, `__NONE__`.",
        "",
        "## Output Checks",
        "",
        "- Train/validation/test feature columns are identical.",
        "- Encoded matrices contain no missing values.",
        "- Sparse `.npz` matrices and CSV matrices use the same feature order as `feature_names.csv`.",
    ])
    (output_dir / "feature_engineering_report.md").write_text("\n".join(report) + "\n", encoding="utf-8", newline="\n")

    print(json.dumps({
        "valid": True,
        "targetColumn": args.target_column,
        "rows": metadata["rows"],
        "encodedFeatureColumns": encoded_train.shape[1],
        "checkboxColumns": len(checkbox_features),
        "categoricalColumns": len(categorical_features),
        "unseenValueColumns": {
            split: len(values)
            for split, values in unseen_summary.items()
        },
        "outputDir": str(output_dir.resolve()),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
