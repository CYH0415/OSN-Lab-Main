#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_INPUT = "data_categories/game/question_graph.json";
const DEFAULT_OUTPUT = "data_categories/game/question_graph_risk_annotated.json";

const inputPath = process.argv[2] || DEFAULT_INPUT;
const outputPath = process.argv[3] || DEFAULT_OUTPUT;

function clamp(value, min = 0, max = 5) {
  return Math.max(min, Math.min(max, value));
}

function has(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function isLowRiskNegative(labelLower) {
  return [
    "no",
    "none",
    "never",
    "no nudity",
    "referred to only",
  ].includes(labelLower);
}

function classifyTags(questionText, optionLabel) {
  const cleanedQuestionText = String(questionText || '')
    .replace(/please note that this question does not refer to user-generated content\.?/gi, ' ');
  const text = `${cleanedQuestionText} ${optionLabel}`.toLowerCase();
  const tags = [];

  if (has(text, ["violence", "violent", "blood", "gore", "gory", "war setting", "historical war", "injured", "killed"])) tags.push("violence");
  if (has(text, ["blood", "gore", "gory", "graphic detail", "disturbing or gory"])) tags.push("gore");
  if (has(text, ["scary", "horrifying", "disturbing", "imminent threat", "sinister", "dark overtones"])) tags.push("fear");
  if (has(text, ["sexual", "sex act", "sexual activity", "innuendo", "suggestive", "dating games", "romantic relationships"])) tags.push("sexual_content");
  if (has(text, ["nudity", "nude", "breasts", "buttocks", "genitalia", "revealing outfits", "under 18"])) tags.push("nudity");
  if (has(text, ["sexual violence"])) tags.push("sexual_violence");
  if (has(text, ["gambling", "casino", "bingo", "lotteries", "racetrack betting", "wager", "cash payouts"])) tags.push("gambling");
  if (has(text, ["profan", "swearing", "offensive language", "discriminatory language", "expletives"])) tags.push("language");
  if (has(text, ["drugs", "alcohol", "tobacco"])) tags.push("substances");
  if (has(text, ["belching", "flatulence", "vomiting", "urination", "feces", "defecation", "mucus"])) tags.push("crude_humor");
  if (has(text, ["interact or exchange content", "voice communication", "sharing images", "sharing audio", "chat moderation", "block users", "report users", "invited friends", "user-generated"])) tags.push("ugc");
  if (has(text, ["block users", "report users", "chat moderation", "invited friends"])) tags.push("ugc_safety");
  if (has(text, ["location"])) tags.push("location_sharing");
  if (has(text, ["purchase", "loot boxes", "random items", "cash rewards", "cryptocurrency", "nft", "transferable digital assets", "marketplace", "trade items"])) tags.push("monetization");
  if (has(text, ["swastikas", "nazi"])) tags.push("hate_symbols");
  if (has(text, ["terrorism"])) tags.push("terrorism");
  if (has(text, ["national identity", "anti-national", "historical facts"])) tags.push("regional_sensitive_content");
  if (has(text, ["crimes", "criminal", "robbery", "kidnapping", "imitated"])) tags.push("crime");

  return unique(tags);
}

function topicBaseSeverity(tags) {
  if (tags.includes("terrorism")) return 5;
  if (tags.includes("sexual_violence")) return 5;
  if (tags.includes("hate_symbols")) return 5;
  if (tags.includes("gore")) return 4;
  if (tags.includes("nudity")) return 4;
  if (tags.includes("gambling")) return 3;
  if (tags.includes("violence")) return 3;
  if (tags.includes("sexual_content")) return 3;
  if (tags.includes("crime")) return 3;
  if (tags.includes("substances")) return 3;
  if (tags.includes("language")) return 2;
  if (tags.includes("fear")) return 2;
  if (tags.includes("ugc")) return 2;
  if (tags.includes("monetization")) return 2;
  if (tags.includes("location_sharing")) return 2;
  if (tags.includes("crude_humor")) return 1;
  return 0;
}

function scoreOption(question, option) {
  const q = question.text || "";
  const label = option.label || "";
  const qLower = q.toLowerCase();
  const labelLower = label.toLowerCase();
  let tags = classifyTags(q, label);
  const childCount = option.children?.length || 0;
  const base = topicBaseSeverity(tags);

  let gateScore = childCount > 0 ? clamp(Math.ceil(Math.log2(childCount + 1)) + 1) : 0;
  let severityScore = 0;
  let confidence = 0.78;
  let reviewNeeded = false;
  let effect = "neutral";
  const isSafetyMitigationQuestion = has(qLower, ["block users", "report users", "chat moderation", "limited to invited friends only"]);

  if (isLowRiskNegative(labelLower) && !isSafetyMitigationQuestion) {
    severityScore = 0;
    gateScore = 0;
    tags = [];
    confidence = 0.93;
  } else if (labelLower === "yes") {
    severityScore = childCount > 0 ? clamp(Math.min(base, 2)) : clamp(base);
    if (childCount > 0) gateScore = clamp(Math.max(gateScore, Math.min(base + 1, 5)));
    confidence = childCount > 0 ? 0.82 : 0.86;
    effect = childCount > 0 ? "branch_gate" : "risk_signal";
  } else {
    severityScore = clamp(base);
    effect = severityScore > 0 ? "risk_signal" : "neutral";
  }

  if (isSafetyMitigationQuestion) {
    tags.push("safety_mitigation");
    gateScore = 0;
    if (labelLower === "yes") {
      severityScore = 0;
      confidence = 0.88;
      effect = "mitigation";
    } else if (labelLower === "no") {
      tags.push("mitigation_missing");
      severityScore = has(qLower, ["chat moderation", "report users"]) ? 3 : 2;
      confidence = 0.82;
      effect = "mitigation_missing";
    }
  }

  if (has(labelLower, ["often", "frequent", "large or frequent", "prolonged"])) {
    severityScore = clamp(Math.max(severityScore, base + 1, 3));
    confidence = 0.87;
  }
  if (has(labelLower, ["rare", "rarely", "brief", "small and infrequent", "limited detail", "referred to", "implied but not seen"])) {
    severityScore = clamp(Math.max(severityScore, Math.min(base, 2)));
    confidence = 0.86;
  }
  if (labelLower === "small and infrequent") severityScore = clamp(Math.min(severityScore, 2));
  if (has(labelLower, ["moderate", "shown with partial nudity", "overtly sexual", "descriptive detail"])) severityScore = clamp(Math.max(severityScore, 3));
  if (has(labelLower, ["high", "graphic detail", "full frontal", "genitalia", "without penalties", "under 18", "younger than 18", "detailed instruction", "encourages/glamorizes", "sexual violence"])) severityScore = 5;
  if (labelLower === "references to sexual activity without descriptive detail") severityScore = 3;
  if (labelLower === "references to sexual activity with descriptive detail") severityScore = 4;

  if (has(labelLower, ["realistic", "real-world animals", "close-up", "innocent or defenseless", "cash payouts", "significant monetary value", "wager", "real money", "first-person perspective"])) {
    severityScore = clamp(Math.max(severityScore, 4));
  }
  if (has(labelLower, ["fantastical", "fantasy creatures", "fantasy drugs", "pixelated style", "childlike style"])) {
    severityScore = clamp(Math.min(severityScore, 2));
  }
  if (has(labelLower, ["sexual activity - includes", "depictions of or references to sexual violence"])) {
    if (childCount > 0) gateScore = clamp(Math.max(gateScore, 5));
    severityScore = clamp(Math.max(severityScore, 5));
  }
  if (has(labelLower, ["nudity", "female human breasts with nipples"])) severityScore = clamp(Math.max(severityScore, 4));
  if (has(labelLower, ["revealing outfits", "dating games", "suggestive references", "minor profanities", "mucus", "belching"])) severityScore = clamp(Math.max(severityScore, 1));
  if (has(labelLower, ["moderate swearing", "discriminatory language", "sexual expletives"])) severityScore = clamp(Math.max(severityScore, 3));
  if (has(labelLower, ["illegal or recreational drugs"])) severityScore = clamp(Math.max(severityScore, 4));
  if (has(labelLower, ["medical drugs", "alcohol", "tobacco"])) severityScore = clamp(Math.max(severityScore, 2));
  if (has(labelLower, ["act of human defecation", "urination", "realistically depicted feces"])) severityScore = clamp(Math.max(severityScore, 3));
  if (has(labelLower, ["cash convertible rewards", "convertible cryptocurrency", "play-to-earn"])) severityScore = clamp(Math.max(severityScore, 5));
  if (has(labelLower, ["loot boxes", "random items", "trade items", "transferable digital assets", "nfts", "integrated marketplace"])) severityScore = clamp(Math.max(severityScore, 3));

  if (has(qLower, ["likely to be imitated", "detailed descriptions of techniques"])) {
    severityScore = labelLower === "yes" ? 5 : 0;
    confidence = 0.9;
  }

  if (question.type === "checkbox" && childCount > 0) {
    gateScore = clamp(Math.max(gateScore, Math.min(severityScore + 1, 5)));
    effect = severityScore >= 3 ? "risk_escalator" : "branch_gate";
  }

  if (labelLower === "yes, with penalties") severityScore = 4;
  if (labelLower === "yes, without penalties") severityScore = 5;

  if (!isSafetyMitigationQuestion && labelLower.includes("no") && labelLower !== "shown with no nudity") {
    severityScore = 0;
    gateScore = 0;
    tags = [];
    effect = "neutral";
  }

  if (severityScore >= 4 && effect === "risk_signal") effect = "risk_escalator";

  if (tags.length === 0 && (severityScore > 0 || gateScore > 0)) reviewNeeded = true;
  if (confidence < 0.8 || (labelLower === "yes" && childCount === 0 && severityScore >= 4)) reviewNeeded = true;

  const samplingPriority = clamp(Math.ceil((severityScore * 0.7) + (gateScore * 0.45)));

  return {
    gateScore,
    severityScore,
    samplingPriority,
    tags: unique(tags),
    confidence: Number(confidence.toFixed(2)),
    reviewNeeded,
    source: "rule",
    effect,
  };
}

function normalizeQuestions(graph) {
  if (Array.isArray(graph.questions)) return graph.questions;
  return Object.values(graph.questions || {});
}

function annotateGraph(graph) {
  const out = structuredClone(graph);
  const questionValues = normalizeQuestions(out);
  for (const question of questionValues) {
    for (const option of Object.values(question.options || {})) {
      option.risk = scoreOption(question, option);
    }
  }
  out.riskAnnotation = {
    version: 1,
    annotatedAt: new Date().toISOString(),
    method: "deterministic semantic pre-annotation",
    schema: {
      gateScore: "0-5: option opens rating-relevant follow-up questions",
      severityScore: "0-5: option's own expected content-rating severity",
      samplingPriority: "0-5: combined priority for directed sampling",
      tags: "risk dimensions used for coverage and combinations",
      confidence: "0-1 heuristic confidence",
      reviewNeeded: "true when the option should be prioritized for model or human review",
    },
  };
  return out;
}

function validate(graph) {
  const missing = [];
  let options = 0;
  const bySeverity = new Map();
  const byTag = new Map();
  const reviewNeeded = [];
  for (const question of normalizeQuestions(graph)) {
    for (const [optionKey, option] of Object.entries(question.options || {})) {
      options += 1;
      if (!option.risk) missing.push(`${question.key} -> ${optionKey}`);
      const severity = option.risk?.severityScore ?? "missing";
      bySeverity.set(severity, (bySeverity.get(severity) || 0) + 1);
      for (const tag of option.risk?.tags || []) byTag.set(tag, (byTag.get(tag) || 0) + 1);
      if (option.risk?.reviewNeeded) reviewNeeded.push(`${question.key} -> ${option.label}`);
    }
  }
  return {
    questions: normalizeQuestions(graph).length,
    options,
    missing,
    bySeverity: Object.fromEntries([...bySeverity.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))),
    byTag: Object.fromEntries([...byTag.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    reviewNeededCount: reviewNeeded.length,
    reviewNeeded: reviewNeeded.slice(0, 30),
  };
}

const graph = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const annotated = annotateGraph(graph);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(annotated, null, 2)}\n`);

const report = validate(annotated);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
if (report.missing.length > 0) process.exitCode = 1;
