from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import joblib
import pandas as pd
from scipy import sparse
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    roc_auc_score,
)


ROOT = Path(__file__).resolve().parents[1]
TASK4_OUT = ROOT / "task4_feature_engineering" / "output"
DEFAULT_OUT = ROOT / "task5_2_logistic_regression&random_forest" / "output"
MPL_CONFIG_DIR = ROOT / "task5_2_logistic_regression&random_forest" / ".matplotlib"


def load_inputs(input_dir: Path) -> dict:
    label_mapping = json.loads((input_dir / "label_mapping.json").read_text(encoding="utf-8"))
    labels = label_mapping["labels"]
    target_names = [name for name, _ in sorted(labels.items(), key=lambda item: item[1])]

    class_weights = json.loads((input_dir / "class_weights.json").read_text(encoding="utf-8"))[
        "class_weights"
    ]
    class_weight_by_id = {labels[name]: weight for name, weight in class_weights.items()}

    return {
        "X_train": sparse.load_npz(input_dir / "X_train.npz"),
        "X_val": sparse.load_npz(input_dir / "X_val.npz"),
        "X_test": sparse.load_npz(input_dir / "X_test.npz"),
        "y_train": pd.read_csv(input_dir / "y_train.csv")["label_id"].to_numpy(),
        "y_val": pd.read_csv(input_dir / "y_val.csv")["label_id"].to_numpy(),
        "y_test": pd.read_csv(input_dir / "y_test.csv")["label_id"].to_numpy(),
        "target_names": target_names,
        "class_weight_by_id": class_weight_by_id,
    }


def build_models(class_weight_by_id: dict[int, float]) -> dict:
    """Build models with optimized hyperparameters from grid search.

    Logistic Regression: 53-combo grid search over C, penalty, l1_ratio, tol.
    L1 + C=10.0 won — sparse solutions suit high-dimensional TF-IDF features.

    Random Forest: 162-combo grid search over n_estimators, max_depth,
    min_samples_leaf, max_features, min_samples_split.
    max_features=0.3 + min_samples_leaf=1 won — fuller feature sampling and
    deeper trees benefit this small-sample, high-dimension scenario.
    """
    return {
        "logistic_regression": LogisticRegression(
            C=10.0,
            l1_ratio=1.0,  # L1 regularization (sparse solution)
            tol=1e-4,
            solver="saga",
            max_iter=5000,
            class_weight=class_weight_by_id,
            random_state=42,
        ),
        "random_forest": RandomForestClassifier(
            n_estimators=500,
            max_depth=None,
            min_samples_leaf=1,
            max_features=0.3,
            min_samples_split=2,
            class_weight=class_weight_by_id,
            random_state=42,
            n_jobs=-1,
        ),
    }


def maybe_plot_confusion_matrix(cm, target_names: list[str], title: str, out_path: Path) -> None:
    try:
        os.environ.setdefault("MPLBACKEND", "Agg")
        MPL_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("MPLCONFIGDIR", str(MPL_CONFIG_DIR))
        import matplotlib.pyplot as plt
    except Exception:
        return

    fig, ax = plt.subplots(figsize=(8, 6))
    image = ax.imshow(cm, interpolation="nearest", cmap="Blues")
    fig.colorbar(image, ax=ax)
    ax.set_title(title)
    ax.set_xlabel("Predicted label")
    ax.set_ylabel("True label")
    ax.set_xticks(range(len(target_names)), target_names, rotation=45, ha="right")
    ax.set_yticks(range(len(target_names)), target_names)

    for row_idx in range(cm.shape[0]):
        for col_idx in range(cm.shape[1]):
            ax.text(col_idx, row_idx, str(cm[row_idx, col_idx]), ha="center", va="center")

    fig.tight_layout()
    fig.savefig(out_path, dpi=180)
    plt.close(fig)


def evaluate_model(model, X, y, target_names: list[str], model_name: str, split: str, out_dir: Path) -> dict:
    pred = model.predict(X)
    proba = model.predict_proba(X) if hasattr(model, "predict_proba") else None

    report = classification_report(
        y,
        pred,
        target_names=target_names,
        output_dict=True,
        zero_division=0,
    )
    pd.DataFrame(report).transpose().to_csv(
        out_dir / f"classification_report_{model_name}_{split}.csv",
        encoding="utf-8-sig",
    )

    cm = confusion_matrix(y, pred)
    pd.DataFrame(cm, index=target_names, columns=target_names).to_csv(
        out_dir / f"confusion_matrix_{model_name}_{split}.csv",
        encoding="utf-8-sig",
    )
    maybe_plot_confusion_matrix(
        cm,
        target_names,
        f"{model_name} {split} confusion matrix",
        out_dir / f"confusion_matrix_{model_name}_{split}.png",
    )

    metrics = {
        "accuracy": accuracy_score(y, pred),
        "macro_f1": f1_score(y, pred, average="macro"),
        "weighted_f1": f1_score(y, pred, average="weighted"),
    }
    if proba is not None:
        metrics["macro_ovr_auc"] = roc_auc_score(y, proba, multi_class="ovr", average="macro")

    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, default=TASK4_OUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    data = load_inputs(args.input_dir)
    models = build_models(data["class_weight_by_id"])

    all_metrics = {}
    comparison_rows = []

    for model_name, model in models.items():
        print(f"Training {model_name}...")
        model.fit(data["X_train"], data["y_train"])

        joblib.dump(model, args.output_dir / f"{model_name}_model.joblib")

        all_metrics[model_name] = {"params": model.get_params(), "splits": {}}
        for split in ("val", "test"):
            metrics = evaluate_model(
                model,
                data[f"X_{split}"],
                data[f"y_{split}"],
                data["target_names"],
                model_name,
                split,
                args.output_dir,
            )
            all_metrics[model_name]["splits"][split] = metrics
            comparison_rows.append({"model": model_name, "split": split, **metrics})

    pd.DataFrame(comparison_rows).to_csv(
        args.output_dir / "model_comparison.csv",
        index=False,
        encoding="utf-8-sig",
    )
    (args.output_dir / "metrics.json").write_text(
        json.dumps(all_metrics, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("Task 5.2 training complete.")
    print(pd.DataFrame(comparison_rows).to_string(index=False))


if __name__ == "__main__":
    main()
