import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const config = {
  graphPath: process.env.RISK_GRAPH || process.argv[2] || 'data_categories/game/question_graph_risk_annotated.json',
  outDir: process.env.MIDBAND_SAMPLE_OUT_DIR || process.argv[3] || 'rating_samples_midband_game',
};

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeAnswers(answers) {
  const byKey = new Map();
  for (const answer of answers.filter(Boolean)) {
    const key = `${answer.questionId}::${answer.type}::${answer.optionLabel}::${answer.value}`;
    if (!byKey.has(key)) byKey.set(key, answer);
  }
  return [...byKey.values()];
}

function isCompatible(answers) {
  const radioByQuestion = new Map();
  const checkboxByOption = new Map();
  for (const answer of answers) {
    if (answer.type === 'radio') {
      const previous = radioByQuestion.get(answer.questionId);
      if (previous && previous !== answer.optionLabel) return false;
      radioByQuestion.set(answer.questionId, answer.optionLabel);
    }
    if (answer.type === 'checkbox') {
      const key = `${answer.questionId}::${answer.optionLabel}`;
      const previous = checkboxByOption.get(key);
      if (previous !== undefined && previous !== answer.value) return false;
      checkboxByOption.set(key, answer.value);
    }
  }
  return true;
}

function makeIndex(graph) {
  const questions = Object.values(graph.questions || {});
  return {
    byKey: new Map(questions.map((question) => [question.key, question])),
    byOrder: new Map(questions.map((question) => [question.order, question])),
  };
}

function option(question, label) {
  const found = Object.values(question.options || {}).find((candidate) => candidate.label === label);
  if (!found) throw new Error(`Option not found: ${question.key} -> ${label}`);
  return found;
}

function answer(question, label) {
  option(question, label);
  return {
    questionId: question.key,
    questionText: question.text,
    type: question.type,
    optionLabel: label,
    value: true,
  };
}

function riskSummary(answers, graph) {
  const riskByAnswer = new Map();
  for (const question of Object.values(graph.questions || {})) {
    for (const candidate of Object.values(question.options || {})) {
      riskByAnswer.set(`${question.key}::${candidate.label}`, candidate.risk || {});
    }
  }
  let score = 0;
  let maxSeverity = 0;
  let highCount = 0;
  const tags = new Set();
  for (const item of answers) {
    const risk = riskByAnswer.get(`${item.questionId}::${item.optionLabel}`) || {};
    score += (risk.severityScore || 0) * 3 + (risk.gateScore || 0);
    maxSeverity = Math.max(maxSeverity, risk.severityScore || 0);
    if ((risk.severityScore || 0) >= 4) highCount += 1;
    if ((risk.severityScore || 0) >= 3 || risk.effect === 'mitigation_missing') {
      for (const tag of risk.tags || []) tags.add(tag);
    }
  }
  return { score, maxSeverity, highCount, tags: [...tags].sort() };
}

function sample(category, categorySlug, strategy, name, answers, graph, meta = {}) {
  const normalized = normalizeAnswers(answers);
  if (!isCompatible(normalized)) throw new Error(`Incompatible sample: ${name}`);
  return {
    sampleId: '',
    category,
    categorySlug,
    strategy,
    answers: normalized,
    riskSummary: riskSummary(normalized, graph),
    meta: { name, ...meta },
  };
}

function buildSamples(graph) {
  const idx = makeIndex(graph);
  const q = (order) => idx.byOrder.get(order);
  const category = graph.category || 'Game';
  const categorySlug = slug(category);
  const samples = [];
  const add = (strategy, name, parts, meta) => samples.push(sample(category, categorySlug, strategy, name, parts, graph, meta));

  add('baseline', 'baseline', []);

  const violenceRoot = q(0);
  const violenceIncludes = q(14);
  const humanSetting = q(15);
  const humanStyle = q(16);
  const humanReaction = q(17);
  const humanPresentation = q(18);
  const humanBlood = q(19);
  const humanWar = q(20);
  const humanInnocent = q(21);
  const humanDark = q(22);

  const violenceBase = [
    answer(violenceRoot, 'Yes'),
    answer(violenceIncludes, 'Violence or implied violence against humans'),
  ];
  const violenceLadders = [
    ['violence_implied_no_blood', 'Fantastical', 'Yes, it has a pixelated style', 'Unrealistic', 'Implied but not seen', 'None', 'No', 'No', 'No'],
    ['violence_referred_mild', 'Fantastical', 'Yes, it has a pixelated style', 'Unrealistic', 'Referred to', 'Mild/Limited', 'No', 'No', 'No'],
    ['violence_rare_distant_mild', 'Fantastical', 'No', 'Unrealistic', 'Rarely depicted from a distant perspective', 'Mild/Limited', 'No', 'No', 'No'],
    ['violence_often_distant_moderate', 'Fantastical', 'No', 'Unrealistic', 'Often depicted from a distant perspective', 'Moderate', 'No', 'No', 'Yes'],
    ['violence_rare_close_moderate', 'Realistic', 'No', 'Realistic', 'Rarely depicted from a close-up perspective', 'Moderate', 'No', 'Yes, with penalties', 'Yes'],
    ['violence_often_close_high_with_penalty', 'Realistic', 'No', 'Realistic', 'Often depicted from a close-up perspective', 'High', 'Yes', 'Yes, with penalties', 'Yes'],
  ];
  for (const [name, setting, style, reaction, presentation, blood, war, innocent, dark] of violenceLadders) {
    add('midband_ladder', name, [
      ...violenceBase,
      answer(humanSetting, setting),
      answer(humanStyle, style),
      answer(humanReaction, reaction),
      answer(humanPresentation, presentation),
      answer(humanBlood, blood),
      answer(humanWar, war),
      answer(humanInnocent, innocent),
      answer(humanDark, dark),
    ], { topic: 'violence' });
  }

  const creaturePresentation = q(24);
  const creatureHumanLike = q(25);
  const creatureAnimal = q(26);
  const creatureLadders = [
    ['creature_referred_nonhuman', 'Referred to', 'No', 'No'],
    ['creature_often_distant_humanlike', 'Often depicted from a distant perspective', 'Yes', 'No'],
    ['creature_rare_close_real_animals', 'Rarely depicted from a close-up perspective', 'No', 'Yes'],
  ];
  for (const [name, presentation, humanLike, animal] of creatureLadders) {
    add('midband_ladder', name, [
      answer(violenceRoot, 'Yes'),
      answer(violenceIncludes, 'Violence against anything other than humans (e.g., animals, fantasy creatures, robots, vehicles)'),
      answer(q(23), 'No'),
      answer(creaturePresentation, presentation),
      answer(creatureHumanLike, humanLike),
      answer(creatureAnimal, animal),
      answer(humanDark, 'No'),
    ], { topic: 'violence_creature' });
  }

  const fearRoot = q(1);
  const fearIncludes = q(29);
  add('midband_ladder', 'scary_rare', [
    answer(fearRoot, 'Yes'),
    answer(fearIncludes, 'Scary elements'),
    answer(q(30), 'Rare'),
  ], { topic: 'fear' });
  add('midband_ladder', 'scary_often', [
    answer(fearRoot, 'Yes'),
    answer(fearIncludes, 'Scary elements'),
    answer(q(30), 'Often'),
  ], { topic: 'fear' });
  add('midband_ladder', 'horrifying_rare', [
    answer(fearRoot, 'Yes'),
    answer(fearIncludes, 'Horrifying elements'),
    answer(q(31), 'Rare'),
  ], { topic: 'fear' });
  add('midband_ladder', 'horrifying_often_no_threat', [
    answer(fearRoot, 'Yes'),
    answer(fearIncludes, 'Horrifying elements'),
    answer(q(31), 'Often'),
    answer(q(32), 'No'),
  ], { topic: 'fear' });
  add('midband_ladder', 'horrifying_often_imminent_threat', [
    answer(fearRoot, 'Yes'),
    answer(fearIncludes, 'Horrifying elements'),
    answer(q(31), 'Often'),
    answer(q(32), 'Yes'),
  ], { topic: 'fear' });

  const sexRoot = q(2);
  const sexIncludes = q(33);
  const sexBase = [answer(sexRoot, 'Yes')];
  add('midband_ladder', 'suggestive_references', [
    ...sexBase,
    answer(sexIncludes, 'Suggestive/Sexual Themes or References'),
    answer(q(38), 'Suggestive references and innuendo in text, dialogue, or heard'),
  ], { topic: 'sexual_content' });
  add('midband_ladder', 'suggestive_overt_visual', [
    ...sexBase,
    answer(sexIncludes, 'Suggestive/Sexual Themes or References'),
    answer(q(38), 'Overtly sexual situations or visually depicted innuendo'),
  ], { topic: 'sexual_content' });
  add('midband_ladder', 'sexual_reference_no_detail', [
    ...sexBase,
    answer(sexIncludes, 'Suggestive/Sexual Themes or References'),
    answer(q(38), 'References to sexual activity without descriptive detail'),
  ], { topic: 'sexual_content' });
  add('midband_ladder', 'sexual_reference_detail', [
    ...sexBase,
    answer(sexIncludes, 'Suggestive/Sexual Themes or References'),
    answer(q(38), 'References to sexual activity with descriptive detail'),
  ], { topic: 'sexual_content' });
  add('midband_ladder', 'dating_not_focus', [
    ...sexBase,
    answer(sexIncludes, 'Dating Games - Interactive dating, marriage, or other romantic relationships between game characters'),
    answer(q(39), 'No'),
  ], { topic: 'sexual_content' });
  add('midband_ladder', 'dating_focus', [
    ...sexBase,
    answer(sexIncludes, 'Dating Games - Interactive dating, marriage, or other romantic relationships between game characters'),
    answer(q(39), 'Yes'),
  ], { topic: 'sexual_content' });
  add('midband_ladder', 'revealing_rare_not_erotic', [
    ...sexBase,
    answer(sexIncludes, 'Nudity or Revealing Outfits'),
    answer(q(40), 'Revealing Outfits'),
    answer(q(41), 'Rarely'),
    answer(q(42), 'No'),
    answer(q(43), 'No'),
  ], { topic: 'nudity' });
  add('midband_ladder', 'revealing_often_erotic', [
    ...sexBase,
    answer(sexIncludes, 'Nudity or Revealing Outfits'),
    answer(q(40), 'Revealing Outfits'),
    answer(q(41), 'Often'),
    answer(q(42), 'Yes'),
    answer(q(43), 'Yes'),
  ], { topic: 'nudity' });
  add('midband_ladder', 'sex_activity_rare_brief_no_nudity', [
    ...sexBase,
    answer(sexIncludes, 'Sexual Activity - Includes both moving and still images of sexual activity'),
    answer(q(34), 'Rarely'),
    answer(q(35), 'Brief'),
    answer(q(36), 'Shown with No Nudity - Characters are depicted in a sexual act but no nudity is shown'),
    answer(q(37), 'No'),
  ], { topic: 'sexual_content' });
  add('high_path_ablation', 'sex_activity_rare_brief_obscured', [
    ...sexBase,
    answer(sexIncludes, 'Sexual Activity - Includes both moving and still images of sexual activity'),
    answer(q(34), 'Rarely'),
    answer(q(35), 'Brief'),
    answer(q(36), 'Obscured/Innuendo - Sex act is either entirely off-camera or completely blocked from view'),
    answer(q(37), 'No'),
  ], { topic: 'sexual_content' });

  const gamblingRoot = q(3);
  const gamblingIncludes = q(52);
  add('midband_ladder', 'gambling_theme_not_focus', [
    answer(gamblingRoot, 'Yes'),
    answer(gamblingIncludes, 'Gambling themes'),
    answer(q(53), 'No'),
  ], { topic: 'gambling' });
  add('midband_ladder', 'gambling_theme_focus', [
    answer(gamblingRoot, 'Yes'),
    answer(gamblingIncludes, 'Gambling themes'),
    answer(q(53), 'Yes'),
  ], { topic: 'gambling' });
  add('midband_ladder', 'bingo_no_cash', [
    answer(gamblingRoot, 'Yes'),
    answer(gamblingIncludes, 'Playable bingo games'),
    answer(q(54), 'No'),
  ], { topic: 'gambling' });
  add('midband_ladder', 'bingo_cash_no_wager', [
    answer(gamblingRoot, 'Yes'),
    answer(gamblingIncludes, 'Playable bingo games'),
    answer(q(54), 'Yes'),
    answer(q(55), 'No'),
  ], { topic: 'gambling' });
  add('midband_ladder', 'casino_cash_no_wager', [
    answer(gamblingRoot, 'Yes'),
    answer(gamblingIncludes, 'Playable casino games, lotteries, or racetrack betting'),
    answer(q(56), 'Yes'),
    answer(q(57), 'No'),
  ], { topic: 'gambling' });

  const languageRoot = q(4);
  const languageIncludes = q(58);
  const languageCases = [
    ['minor_profanity_rare', 'Minor profanities (e.g., "go to hell")', q(59), 'Rarely'],
    ['minor_profanity_often', 'Minor profanities (e.g., "go to hell")', q(59), 'Often'],
    ['moderate_swearing_rare', 'Moderate swearing or other language or gestures that could be considered moderately or significantly offensive', q(60), 'Rarely'],
    ['moderate_swearing_often', 'Moderate swearing or other language or gestures that could be considered moderately or significantly offensive', q(60), 'Often'],
    ['sexual_expletives_rare', 'Sexual expletives', q(62), 'Rarely'],
    ['sexual_expletives_often', 'Sexual expletives', q(62), 'Often'],
  ];
  for (const [name, include, freqQ, freq] of languageCases) {
    add('midband_ladder', name, [
      answer(languageRoot, 'Yes'),
      answer(languageIncludes, include),
      answer(freqQ, freq),
    ], { topic: 'language' });
  }

  const substanceRoot = q(5);
  const substanceIncludes = q(63);
  add('midband_ladder', 'alcohol_reference_rare', [
    answer(substanceRoot, 'Yes'),
    answer(substanceIncludes, 'Alcohol'),
    answer(q(71), 'Reference'),
    answer(q(72), 'Rarely'),
  ], { topic: 'substances' });
  add('midband_ladder', 'alcohol_use_rare_no_first_person', [
    answer(substanceRoot, 'Yes'),
    answer(substanceIncludes, 'Alcohol'),
    answer(q(71), 'Use'),
    answer(q(72), 'Rarely'),
    answer(q(73), 'No'),
  ], { topic: 'substances' });
  add('midband_ladder', 'tobacco_use_often_first_person', [
    answer(substanceRoot, 'Yes'),
    answer(substanceIncludes, 'Tobacco'),
    answer(q(74), 'Use'),
    answer(q(75), 'Often'),
    answer(q(76), 'Yes'),
  ], { topic: 'substances' });
  add('midband_ladder', 'illegal_drug_reference', [
    answer(substanceRoot, 'Yes'),
    answer(substanceIncludes, 'Illegal or Recreational Drugs'),
    answer(q(64), 'Reference'),
  ], { topic: 'substances' });
  add('midband_ladder', 'illegal_drug_use_no_interactive_no_reward', [
    answer(substanceRoot, 'Yes'),
    answer(substanceIncludes, 'Illegal or Recreational Drugs'),
    answer(q(64), 'Use'),
    answer(q(65), 'No'),
    answer(q(66), 'No'),
  ], { topic: 'substances' });

  return samples.map((item, index) => ({
    ...item,
    sampleId: `${categorySlug}_mid_${String(index + 1).padStart(5, '0')}`,
  }));
}

async function main() {
  const graph = JSON.parse(await readFile(config.graphPath, 'utf8'));
  const samples = buildSamples(graph);
  await mkdir(config.outDir, { recursive: true });
  const samplePath = `${config.outDir}/midband_samples.jsonl`;
  await writeFile(samplePath, samples.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const summary = {
    generatedAt: new Date().toISOString(),
    graphPath: resolve(config.graphPath),
    samplePath: resolve(samplePath),
    sampleCount: samples.length,
    strategyCounts: samples.reduce((acc, item) => {
      acc[item.strategy] = (acc[item.strategy] || 0) + 1;
      return acc;
    }, {}),
    topicCounts: samples.reduce((acc, item) => {
      const topic = item.meta.topic || 'baseline';
      acc[topic] = (acc[topic] || 0) + 1;
      return acc;
    }, {}),
    severityCounts: samples.reduce((acc, item) => {
      const key = String(item.riskSummary.maxSeverity);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
  await writeFile(`${config.outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
