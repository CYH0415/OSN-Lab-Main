import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const config = {
  categoryRoot: process.env.CATEGORY_OUT_ROOT || 'data_categories',
  outDir: process.env.BALANCED_SAMPLE_OUT_DIR || 'rating_samples_balanced',
};

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function questionValues(graph) {
  return Object.values(graph.questions || {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function options(question) {
  return Object.values(question?.options || {});
}

function hasOption(question, label) {
  return options(question).some((option) => option.label === label);
}

function findQuestion(graph, { text = [], anyText = [], labels = [], type = '' }) {
  const requiredText = text.map(norm);
  const alternativeText = anyText.map(norm);
  return questionValues(graph).find((question) => {
    if (type && question.type !== type) return false;
    const qText = norm(question.text);
    if (requiredText.some((part) => !qText.includes(part))) return false;
    if (alternativeText.length && !alternativeText.some((part) => qText.includes(part))) return false;
    if (labels.some((label) => !hasOption(question, label))) return false;
    return true;
  });
}

function findByOptionLabels(graph, labels, extra = {}) {
  return findQuestion(graph, { ...extra, labels });
}

function option(question, label) {
  const found = options(question).find((candidate) => candidate.label === label);
  if (!found) throw new Error(`Option not found: ${question?.key || 'missing question'} -> ${label}`);
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

function normalizeAnswers(answers) {
  const byKey = new Map();
  for (const item of answers.filter(Boolean)) {
    const key = `${item.questionId}::${item.type}::${item.optionLabel}::${item.value}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function isCompatible(answers) {
  const radioByQuestion = new Map();
  for (const item of answers) {
    if (item.type !== 'radio') continue;
    const previous = radioByQuestion.get(item.questionId);
    if (previous && previous !== item.optionLabel) return false;
    radioByQuestion.set(item.questionId, item.optionLabel);
  }
  return true;
}

function riskSummary(answers, graph) {
  const riskByAnswer = new Map();
  for (const question of questionValues(graph)) {
    for (const opt of options(question)) riskByAnswer.set(`${question.key}::${opt.label}`, opt.risk || {});
  }

  const tags = new Set();
  let score = 0;
  let maxSeverity = 0;
  let highCount = 0;
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

function makeSample(graph, strategy, name, answers, meta = {}) {
  const normalized = normalizeAnswers(answers);
  if (!isCompatible(normalized)) throw new Error(`Incompatible sample: ${graph.category} / ${name}`);
  return {
    sampleId: '',
    category: graph.category,
    categorySlug: slug(graph.category),
    strategy,
    answers: normalized,
    riskSummary: riskSummary(normalized, graph),
    meta: { name, ...meta },
  };
}

function safeAdd(samples, graph, strategy, name, answers, meta = {}) {
  try {
    samples.push(makeSample(graph, strategy, name, answers, meta));
  } catch (error) {
    samples.push({
      skipped: true,
      category: graph.category,
      strategy,
      meta: { name, error: error.message, ...meta },
    });
  }
}

function contentGateAnswers(graph) {
  const gate = findQuestion(graph, {
    text: ['ratings-relevant content', 'downloaded'],
    labels: ['Yes', 'No'],
    type: 'radio',
  });
  return gate ? [answer(gate, 'Yes')] : [];
}

function topicRoot(graph, requiredText, labels = ['Yes', 'No']) {
  return findQuestion(graph, { text: requiredText, labels, type: 'radio' });
}

function addViolence(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root = topicRoot(graph, ['violence', 'blood', 'gory images']);
  const include = findByOptionLabels(graph, ['Violence or implied violence against humans'], { type: 'checkbox' });
  if (!root || !include) return;

  const base = [...gate, answer(root, 'Yes'), answer(include, 'Violence or implied violence against humans')];
  const setting = findQuestion(graph, { text: ['setting', 'violence'], labels: ['Fantastical', 'Realistic'] });
  const style = findQuestion(graph, { text: ['pixelated or childlike style'], labels: ['Yes, it has a pixelated style'] });
  const reaction = findQuestion(graph, { text: ['reactions to violence'], labels: ['Unrealistic', 'Realistic'] });
  const presentation = findByOptionLabels(graph, ['Implied but not seen'], { type: 'checkbox' });
  const blood = findQuestion(graph, { text: ['level of blood'], labels: ['None', 'Mild/Limited', 'Moderate', 'High'] });
  const war = findQuestion(graph, { text: ['war setting'], labels: ['Yes', 'No'] });
  const innocent = findQuestion(graph, { text: ['innocent or defenseless'], labels: ['No', 'Yes, with penalties'] });
  const dark = findQuestion(graph, { text: ['fierce sounds'], labels: ['Yes', 'No'] });
  if (!setting || !style || !reaction || !presentation || !blood || !war || !innocent || !dark) return;

  const rows = [
    ['violence_implied_no_blood', 'Fantastical', 'Yes, it has a pixelated style', 'Unrealistic', 'Implied but not seen', 'None', 'No', 'No', 'No'],
    ['violence_referred_mild', 'Fantastical', 'Yes, it has a pixelated style', 'Unrealistic', 'Referred to', 'Mild/Limited', 'No', 'No', 'No'],
    ['violence_rare_distant_mild', 'Fantastical', 'No', 'Unrealistic', 'Rarely depicted from a distant perspective', 'Mild/Limited', 'No', 'No', 'No'],
    ['violence_often_distant_moderate', 'Fantastical', 'No', 'Unrealistic', 'Often depicted from a distant perspective', 'Moderate', 'No', 'No', 'Yes'],
    ['violence_rare_close_moderate', 'Realistic', 'No', 'Realistic', 'Rarely depicted from a close-up perspective', 'Moderate', 'No', 'Yes, with penalties', 'Yes'],
  ];

  for (const [name, settingOpt, styleOpt, reactionOpt, presentationOpt, bloodOpt, warOpt, innocentOpt, darkOpt] of rows) {
    safeAdd(samples, graph, 'balanced_ladder', name, [
      ...base,
      answer(setting, settingOpt),
      answer(style, styleOpt),
      answer(reaction, reactionOpt),
      answer(presentation, presentationOpt),
      answer(blood, bloodOpt),
      answer(war, warOpt),
      answer(innocent, innocentOpt),
      answer(dark, darkOpt),
    ], { topic: 'violence' });
  }

  const creatureInclude = option(include, 'Violence against anything other than humans (e.g., animals, fantasy creatures, robots, vehicles)');
  const creaturePresentation = questionValues(graph).find(
    (question) =>
      question.type === 'checkbox' &&
      norm(question.text).includes('violence presented') &&
      hasOption(question, 'Rarely depicted from a close-up perspective') &&
      hasOption(question, 'Often depicted from a distant perspective') &&
      !hasOption(question, 'Implied but not seen'),
  );
  const humanLike = findQuestion(graph, { text: ['behave or respond like humans'], labels: ['Yes', 'No'] });
  const animal = findQuestion(graph, { text: ['real-world animals'], labels: ['Yes', 'No'] });
  const creatureStyle = findQuestion(graph, { text: ['pixelated or childlike style'], labels: ['Yes', 'No'] });
  if (creatureInclude && creaturePresentation && humanLike && animal && creatureStyle) {
    const creatureBase = [...gate, answer(root, 'Yes'), answer(include, creatureInclude.label)];
    safeAdd(samples, graph, 'balanced_ladder', 'creature_often_distant_humanlike', [
      ...creatureBase,
      answer(creatureStyle, 'No'),
      answer(creaturePresentation, 'Often depicted from a distant perspective'),
      answer(humanLike, 'Yes'),
      answer(animal, 'No'),
      answer(dark, 'No'),
    ], { topic: 'violence_creature' });
    safeAdd(samples, graph, 'balanced_ladder', 'creature_rare_close_real_animals', [
      ...creatureBase,
      answer(creatureStyle, 'No'),
      answer(creaturePresentation, 'Rarely depicted from a close-up perspective'),
      answer(humanLike, 'No'),
      answer(animal, 'Yes'),
      answer(dark, 'No'),
    ], { topic: 'violence_creature' });
  }
}

function addFear(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root = topicRoot(graph, ['pictures or sounds', 'scary']);
  const include = findByOptionLabels(graph, ['Scary elements', 'Horrifying elements'], { type: 'checkbox' });
  const scaryFreq = findQuestion(graph, { text: ['scary elements'], labels: ['Rare', 'Often'] });
  const horrorFreq = findQuestion(graph, { text: ['horrifying elements'], labels: ['Rare', 'Often'] });
  const threat = findQuestion(graph, { text: ['imminent threat'], labels: ['Yes', 'No'] });
  if (!root || !include || !scaryFreq || !horrorFreq) return;
  const base = [...gate, answer(root, 'Yes')];
  safeAdd(samples, graph, 'balanced_ladder', 'scary_rare', [...base, answer(include, 'Scary elements'), answer(scaryFreq, 'Rare')], { topic: 'fear' });
  safeAdd(samples, graph, 'balanced_ladder', 'scary_often', [...base, answer(include, 'Scary elements'), answer(scaryFreq, 'Often')], { topic: 'fear' });
  safeAdd(samples, graph, 'balanced_ladder', 'horrifying_rare', [...base, answer(include, 'Horrifying elements'), answer(horrorFreq, 'Rare')], { topic: 'fear' });
  if (threat) {
    safeAdd(samples, graph, 'balanced_ladder', 'horrifying_often_no_threat', [...base, answer(include, 'Horrifying elements'), answer(horrorFreq, 'Often'), answer(threat, 'No')], { topic: 'fear' });
    safeAdd(samples, graph, 'balanced_ladder', 'horrifying_often_imminent_threat', [...base, answer(include, 'Horrifying elements'), answer(horrorFreq, 'Often'), answer(threat, 'Yes')], { topic: 'fear' });
  }
}

function addSexualContent(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root = topicRoot(graph, ['sexuality', 'nudity']);
  const include = findByOptionLabels(graph, ['Suggestive/Sexual Themes or References'], { type: 'checkbox' });
  const suggestive = findByOptionLabels(graph, ['Suggestive references and innuendo in text, dialogue, or heard'], { type: 'checkbox' });
  if (!root || !include || !suggestive) return;
  const base = [...gate, answer(root, 'Yes')];
  for (const [name, label] of [
    ['suggestive_references', 'Suggestive references and innuendo in text, dialogue, or heard'],
    ['suggestive_overt_visual', 'Overtly sexual situations or visually depicted innuendo'],
    ['sexual_reference_no_detail', 'References to sexual activity without descriptive detail'],
    ['sexual_reference_detail', 'References to sexual activity with descriptive detail'],
  ]) {
    if (hasOption(suggestive, label)) {
      safeAdd(samples, graph, 'balanced_ladder', name, [...base, answer(include, 'Suggestive/Sexual Themes or References'), answer(suggestive, label)], { topic: 'sexual_content' });
    }
  }

  const revealingSelect = findByOptionLabels(graph, ['Revealing Outfits'], { type: 'checkbox' });
  const revealingFreq = findQuestion(graph, { text: ['revealing outfits', 'frequently'], labels: ['Rarely', 'Often'] });
  const revealingErotic = findQuestion(graph, { text: ['revealing outfits', 'erotic'], labels: ['Yes', 'No'] });
  const revealingOutOfPlace = findQuestion(graph, { text: ['out-of-place'], labels: ['Yes', 'No'] });
  if (revealingSelect && revealingFreq && revealingErotic && revealingOutOfPlace && hasOption(include, 'Nudity or Revealing Outfits')) {
    safeAdd(samples, graph, 'balanced_ladder', 'revealing_rare_not_erotic', [
      ...base,
      answer(include, 'Nudity or Revealing Outfits'),
      answer(revealingSelect, 'Revealing Outfits'),
      answer(revealingFreq, 'Rarely'),
      answer(revealingErotic, 'No'),
      answer(revealingOutOfPlace, 'No'),
    ], { topic: 'nudity' });
    safeAdd(samples, graph, 'balanced_ladder', 'revealing_often_erotic', [
      ...base,
      answer(include, 'Nudity or Revealing Outfits'),
      answer(revealingSelect, 'Revealing Outfits'),
      answer(revealingFreq, 'Often'),
      answer(revealingErotic, 'Yes'),
      answer(revealingOutOfPlace, 'Yes'),
    ], { topic: 'nudity' });
  }

  const sexualActivity = findByOptionLabels(graph, ['Sexual Activity - Includes both moving and still images of sexual activity'], { type: 'checkbox' });
  const actsFreq = findQuestion(graph, { text: ['sexual acts occur'], labels: ['Rarely', 'Often'] });
  const duration = findQuestion(graph, { text: ['duration of these scenes'], labels: ['Brief', 'Prolonged'] });
  const depiction = findByOptionLabels(graph, ['Shown with No Nudity - Characters are depicted in a sexual act but no nudity is shown'], { type: 'checkbox' });
  const under18 = findQuestion(graph, { text: ['appear to be younger than 18'], labels: ['Yes', 'No'] });
  if (sexualActivity && actsFreq && duration && depiction && under18) {
    safeAdd(samples, graph, 'balanced_ladder', 'sex_activity_rare_brief_no_nudity', [
      ...base,
      answer(include, sexualActivity.options?.label || 'Sexual Activity - Includes both moving and still images of sexual activity'),
      answer(actsFreq, 'Rarely'),
      answer(duration, 'Brief'),
      answer(depiction, 'Shown with No Nudity - Characters are depicted in a sexual act but no nudity is shown'),
      answer(under18, 'No'),
    ], { topic: 'sexual_content' });
  }
}

function addGambling(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root =
    findQuestion(graph, {
      text: ['contain gambling'],
      anyText: ['simulations', 'casino', 'bingo', 'themes'],
      labels: ['Yes', 'No'],
      type: 'radio',
    }) || topicRoot(graph, ['gambling']);
  const include = findByOptionLabels(graph, ['Gambling themes'], { type: 'checkbox' });
  if (!root || !include) return;
  const base = [...gate, answer(root, 'Yes')];
  const focus = findQuestion(graph, { text: ['gambling themes', 'strong focus'], labels: ['Yes', 'No'] });
  if (focus) {
    safeAdd(samples, graph, 'balanced_ladder', 'gambling_theme_not_focus', [...base, answer(include, 'Gambling themes'), answer(focus, 'No')], { topic: 'gambling' });
    safeAdd(samples, graph, 'balanced_ladder', 'gambling_theme_focus', [...base, answer(include, 'Gambling themes'), answer(focus, 'Yes')], { topic: 'gambling' });
  }
  const bingoCash = findQuestion(graph, { text: ['bingo games', 'cash payouts'], labels: ['Yes', 'No'] });
  const bingoWager = findQuestion(graph, { text: ['bingo games', 'wager'], labels: ['Yes', 'No'] });
  if (bingoCash && hasOption(include, 'Playable bingo games')) {
    safeAdd(samples, graph, 'balanced_ladder', 'bingo_no_cash', [...base, answer(include, 'Playable bingo games'), answer(bingoCash, 'No')], { topic: 'gambling' });
    if (bingoWager) {
      safeAdd(samples, graph, 'balanced_ladder', 'bingo_cash_no_wager', [...base, answer(include, 'Playable bingo games'), answer(bingoCash, 'Yes'), answer(bingoWager, 'No')], { topic: 'gambling' });
    }
  }
}

function addLanguage(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root = topicRoot(graph, ['offensive language']);
  const include = findByOptionLabels(graph, ['Minor profanities (e.g., "go to hell")'], { type: 'checkbox' });
  if (!root || !include) return;
  const base = [...gate, answer(root, 'Yes')];
  const cases = [
    ['minor_profanity_rare', 'Minor profanities (e.g., "go to hell")', ['minor profanities'], 'Rarely'],
    ['minor_profanity_often', 'Minor profanities (e.g., "go to hell")', ['minor profanities'], 'Often'],
    ['moderate_swearing_often', 'Moderate swearing or other language or gestures that could be considered moderately or significantly offensive', ['moderate swearing'], 'Often'],
    ['sexual_expletives_rare', 'Sexual expletives', ['sexual expletives'], 'Rarely'],
    ['sexual_expletives_often', 'Sexual expletives', ['sexual expletives'], 'Often'],
  ];
  for (const [name, includeLabel, qText, freq] of cases) {
    if (!hasOption(include, includeLabel)) continue;
    const freqQ = findQuestion(graph, { text: qText, labels: ['Rarely', 'Often'] });
    if (freqQ) safeAdd(samples, graph, 'balanced_ladder', name, [...base, answer(include, includeLabel), answer(freqQ, freq)], { topic: 'language' });
  }
}

function addSubstances(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root = topicRoot(graph, ['drugs', 'alcohol', 'tobacco']);
  const include = findByOptionLabels(graph, ['Illegal or Recreational Drugs', 'Alcohol', 'Tobacco'], { type: 'checkbox' });
  if (!root || !include) return;
  const base = [...gate, answer(root, 'Yes')];
  const alcohol = findByOptionLabels(graph, ['Reference', 'Use', 'Encourages/Glamorizes'], { text: ['alcohol'], type: 'checkbox' });
  const alcoholFreq = findQuestion(graph, { text: ['alcohol content occur'], labels: ['Rarely', 'Often'] });
  const alcoholFirstPerson = findQuestion(graph, { text: ['use alcohol', 'first-person'], labels: ['Yes', 'No'] });
  if (alcohol && alcoholFreq) {
    safeAdd(samples, graph, 'balanced_ladder', 'alcohol_reference_rare', [...base, answer(include, 'Alcohol'), answer(alcohol, 'Reference'), answer(alcoholFreq, 'Rarely')], { topic: 'substances' });
    if (alcoholFirstPerson) {
      safeAdd(samples, graph, 'balanced_ladder', 'alcohol_use_rare_no_first_person', [...base, answer(include, 'Alcohol'), answer(alcohol, 'Use'), answer(alcoholFreq, 'Rarely'), answer(alcoholFirstPerson, 'No')], { topic: 'substances' });
    }
  }
  const illegal = findByOptionLabels(graph, ['Reference', 'Use', 'Detailed Instruction for Use'], { text: ['illegal or recreational drugs'], type: 'checkbox' });
  const interactive = findQuestion(graph, { text: ['illegal or recreational drugs', 'interactive'], labels: ['Yes', 'No'] });
  const reward = findQuestion(graph, { text: ['illegal or recreational drugs', 'incentives or rewards'], labels: ['Yes', 'No'] });
  if (illegal) {
    safeAdd(samples, graph, 'balanced_ladder', 'illegal_drug_reference', [...base, answer(include, 'Illegal or Recreational Drugs'), answer(illegal, 'Reference')], { topic: 'substances' });
    if (interactive && reward) {
      safeAdd(samples, graph, 'balanced_ladder', 'illegal_drug_use_no_interactive_no_reward', [...base, answer(include, 'Illegal or Recreational Drugs'), answer(illegal, 'Use'), answer(interactive, 'No'), answer(reward, 'No')], { topic: 'substances' });
    }
  }
}

function addUgcSafety(samples, graph) {
  const interactionRoot = topicRoot(graph, ['interact or exchange content']);
  const socialTypeRoot = findQuestion(graph, {
    text: ['which of the following would best describe'],
    labels: [
      'Social - used to communicate, post, and share content with large groups of people or for meeting new people. Facebook, Twitter, Instagram, Tinder are examples of these types of products.',
    ],
  });
  const root = interactionRoot || socialTypeRoot;
  if (!root) return;
  const rootAnswer = interactionRoot
    ? answer(root, 'Yes')
    : answer(
        root,
        'Social - used to communicate, post, and share content with large groups of people or for meeting new people. Facebook, Twitter, Instagram, Tinder are examples of these types of products.',
      );
  const primary = findQuestion(graph, { text: ['primary source of content'], labels: ['Yes', 'No'] });
  const dating = findQuestion(graph, { text: ['dating or sexual relationships'], labels: ['Yes', 'No'] });
  const publicNudity = findQuestion(graph, { text: ['public sharing of nudity'], labels: ['Yes', 'No'] });
  const publicViolence = findQuestion(graph, { text: ['public sharing of real-world', 'graphic violence'], labels: ['Yes', 'No'] });
  const block = findQuestion(graph, { text: ['block users'], labels: ['Yes', 'No'] });
  const report = findQuestion(graph, { text: ['report users'], labels: ['Yes', 'No'] });
  const moderation = findQuestion(graph, { text: ['chat moderation'], labels: ['Yes', 'No'] });
  const friends = findQuestion(graph, { text: ['invited friends'], labels: ['Yes', 'No'] });
  const base = [rootAnswer];
  if (primary && block && report && moderation && friends) {
    safeAdd(samples, graph, 'balanced_ladder', 'ugc_with_safety_controls', [
      ...base,
      answer(primary, 'No'),
      block && answer(block, 'Yes'),
      report && answer(report, 'Yes'),
      moderation && answer(moderation, 'Yes'),
      friends && answer(friends, 'Yes'),
    ], { topic: 'ugc' });
    safeAdd(samples, graph, 'balanced_ladder', 'ugc_missing_safety_controls', [
      ...base,
      answer(primary, 'Yes'),
      answer(block, 'No'),
      answer(report, 'No'),
      answer(moderation, 'No'),
      answer(friends, 'No'),
    ], { topic: 'ugc' });
  }
  if (dating) {
    safeAdd(samples, graph, 'balanced_ladder', 'social_dating_not_focus', [
      ...base,
      primary && answer(primary, 'No'),
      answer(dating, 'Yes'),
      block && answer(block, 'Yes'),
      report && answer(report, 'Yes'),
      moderation && answer(moderation, 'Yes'),
      friends && answer(friends, 'Yes'),
    ], { topic: 'ugc_dating' });
  }
  if (publicNudity) {
    safeAdd(samples, graph, 'balanced_ladder', 'ugc_public_nudity_not_primary', [
      ...base,
      primary && answer(primary, 'Yes'),
      answer(publicNudity, 'Yes'),
      ...options(publicNudity).find((opt) => opt.label === 'Yes')?.children?.map((childId) => {
        const child = graph.questions[childId];
        return child && hasOption(child, 'No') ? answer(child, 'No') : null;
      }).filter(Boolean) || [],
    ], { topic: 'ugc_nudity' });
  }
  if (publicViolence) {
    safeAdd(samples, graph, 'balanced_ladder', 'ugc_public_graphic_violence', [
      ...base,
      primary && answer(primary, 'Yes'),
      answer(publicViolence, 'Yes'),
    ], { topic: 'ugc_violence' });
  }
}

function addCatalogContent(samples, graph) {
  const root = topicRoot(graph, ['feature or promote content', 'initial app download']);
  if (!root) return;
  const base = [answer(root, 'Yes')];
  const primary = findQuestion(graph, { text: ['primary purpose of the app'], labels: ['Yes', 'No'] });
  const catalogViolence = topicRoot(graph, ['contain violent material']);
  const visualViolence = findQuestion(graph, { text: ['violent material', 'visually depicted'], labels: ['Yes', 'No'] });
  const gory = findQuestion(graph, { text: ['violent images', 'gross or gory'], labels: ['Yes', 'No'] });
  const textViolence = findQuestion(graph, { text: ['violent material', 'text or spoken'], labels: ['Yes', 'No'] });
  if (catalogViolence && primary && visualViolence && gory && textViolence) {
    safeAdd(samples, graph, 'balanced_ladder', 'catalog_violence_text_not_primary', [...base, answer(catalogViolence, 'Yes'), answer(primary, 'No'), answer(visualViolence, 'No'), answer(textViolence, 'Yes')], { topic: 'catalog_violence' });
    safeAdd(samples, graph, 'balanced_ladder', 'catalog_violence_visual_not_gory', [...base, answer(catalogViolence, 'Yes'), answer(primary, 'No'), answer(visualViolence, 'Yes'), answer(gory, 'No')], { topic: 'catalog_violence' });
    safeAdd(samples, graph, 'balanced_ladder', 'catalog_violence_gory_primary', [...base, answer(catalogViolence, 'Yes'), answer(primary, 'Yes'), answer(visualViolence, 'Yes'), answer(gory, 'Yes')], { topic: 'catalog_violence' });
  }
}

function addCatalogRestrictions(samples, graph) {
  const root = topicRoot(graph, ['feature or promote content', 'initial app download']);
  if (!root) return;
  const base = [answer(root, 'Yes')];
  const primaryPurpose = findQuestion(graph, { text: ['primary purpose of the app'], labels: ['Yes', 'No'] });
  const contentFocus = findQuestion(graph, { text: ['content the focus of the app'], labels: ['Yes', 'No'] });

  const sexual = topicRoot(graph, ['contain sexual material or nudity']);
  const sexualVisual = findQuestion(graph, { text: ['sexual material', 'visually depicted'], labels: ['Yes', 'No'] });
  const sexualText = findQuestion(graph, { text: ['sexual material', 'text or spoken'], labels: ['Yes', 'No'] });
  const nudity = findQuestion(graph, { text: ['sexual images depict nudity'], labels: ['Yes', 'No'] });
  const pornographic = findQuestion(graph, { text: ['sexual images be pornographic'], labels: ['Yes', 'No'] });
  if (sexual && primaryPurpose && sexualVisual && sexualText && nudity && pornographic) {
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_sexual_text_not_primary', [
      ...base, answer(sexual, 'Yes'), answer(primaryPurpose, 'No'), answer(sexualVisual, 'No'), answer(sexualText, 'Yes'),
    ], { topic: 'catalog_sexual' });
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_nudity_not_pornographic', [
      ...base, answer(sexual, 'Yes'), answer(primaryPurpose, 'No'), answer(sexualVisual, 'Yes'), answer(nudity, 'Yes'), answer(pornographic, 'No'),
    ], { topic: 'catalog_sexual' });
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_pornographic_primary', [
      ...base, answer(sexual, 'Yes'), answer(primaryPurpose, 'Yes'), answer(sexualVisual, 'Yes'), answer(nudity, 'Yes'), answer(pornographic, 'Yes'),
    ], { topic: 'catalog_sexual' });
  }

  const language = topicRoot(graph, ['can the app contain any potentially offensive language']);
  const minor = findQuestion(graph, { text: ['contain minor profanities'], labels: ['Yes', 'No'] });
  const moderate = findQuestion(graph, { text: ['contain moderate swearing'], labels: ['Yes', 'No'] });
  const discriminatory = findQuestion(graph, { text: ['contain discriminatory language'], labels: ['Yes', 'No'] });
  const sexualExpletive = findQuestion(graph, { text: ['contain sexual expletives'], labels: ['Yes', 'No'] });
  if (language && contentFocus && minor && moderate && discriminatory && sexualExpletive) {
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_minor_language_not_focus', [
      ...base, answer(language, 'Yes'), answer(contentFocus, 'No'), answer(minor, 'Yes'), answer(moderate, 'No'), answer(discriminatory, 'No'), answer(sexualExpletive, 'No'),
    ], { topic: 'catalog_language' });
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_moderate_language_focus', [
      ...base, answer(language, 'Yes'), answer(contentFocus, 'Yes'), answer(minor, 'Yes'), answer(moderate, 'Yes'), answer(discriminatory, 'No'), answer(sexualExpletive, 'No'),
    ], { topic: 'catalog_language' });
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_discriminatory_and_sexual_language', [
      ...base, answer(language, 'Yes'), answer(contentFocus, 'Yes'), answer(discriminatory, 'Yes'), answer(sexualExpletive, 'Yes'),
    ], { topic: 'catalog_language' });
  }

  const drugs = topicRoot(graph, ['contain references to or depictions of illegal or recreational drugs']);
  const visualDrugs = findQuestion(graph, { text: ['visual depictions of illegal or recreational drugs'], labels: ['Yes', 'No'] });
  const textDrugs = findQuestion(graph, { text: ['drugs be referred to through text'], labels: ['Yes', 'No'] });
  if (drugs && contentFocus && visualDrugs && textDrugs) {
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_drug_text_not_focus', [
      ...base, answer(drugs, 'Yes'), answer(contentFocus, 'No'), answer(visualDrugs, 'No'), answer(textDrugs, 'Yes'),
    ], { topic: 'catalog_substances' });
    safeAdd(samples, graph, 'balanced_supplemental', 'catalog_drug_visual_focus', [
      ...base, answer(drugs, 'Yes'), answer(contentFocus, 'Yes'), answer(visualDrugs, 'Yes'), answer(textDrugs, 'Yes'),
    ], { topic: 'catalog_substances' });
  }
}

function addCommerceAndUtility(samples, graph) {
  const location = topicRoot(graph, ['precise physical location']);
  if (location) {
    safeAdd(samples, graph, 'balanced_supplemental', 'precise_location_shared', [answer(location, 'Yes')], { topic: 'location_sharing' });
  }

  const purchases = topicRoot(graph, ['purchase digital goods']);
  const randomItems = findQuestion(graph, { text: ['purchases include random items'], labels: ['Yes', 'No'] });
  if (purchases && randomItems) {
    safeAdd(samples, graph, 'balanced_supplemental', 'digital_goods_no_random_items', [answer(purchases, 'Yes'), answer(randomItems, 'No')], { topic: 'monetization' });
    safeAdd(samples, graph, 'balanced_supplemental', 'digital_goods_random_items', [answer(purchases, 'Yes'), answer(randomItems, 'Yes')], { topic: 'monetization' });
  }

  const rewardRoot = topicRoot(graph, ['cash rewards', 'gift cards', 'play-to-earn']);
  const rewardLabel = 'Cash Convertible Rewards - Cash rewards, real-world items of significant monetary value, convertible cryptocurrency rewards or other play-to-earn mechanics';
  const rewardTypes = findByOptionLabels(graph, [rewardLabel], { type: 'checkbox' });
  const rewardWager = rewardTypes
    ? (rewardTypes.options[rewardLabel]?.children || [])
      .map((questionId) => graph.questions[questionId])
      .find((question) => question && ['Yes', 'No'].every((label) => hasOption(question, label)))
    : null;
  if (rewardRoot && rewardTypes && rewardWager) {
    safeAdd(samples, graph, 'balanced_supplemental', 'cash_rewards_without_wager', [answer(rewardRoot, 'Yes'), answer(rewardTypes, rewardLabel), answer(rewardWager, 'No')], { topic: 'monetization' });
    safeAdd(samples, graph, 'balanced_supplemental', 'cash_rewards_with_wager', [answer(rewardRoot, 'Yes'), answer(rewardTypes, rewardLabel), answer(rewardWager, 'Yes')], { topic: 'monetization' });
  }

  const nftLabel = 'Issuance (e.g., minting) of transferable digital assets (e.g., NFTs)';
  const nftTypes = findByOptionLabels(graph, [nftLabel], { type: 'checkbox' });
  const nftSignificant = findQuestion(graph, { text: ['issuance of these digital assets', 'significant'], labels: ['Yes', 'No'] });
  const nftMarket = findQuestion(graph, { text: ['integrated marketplace'], labels: ['Yes', 'No'] });
  const nftPurchase = findQuestion(graph, { text: ['purchases related to the issuance'], labels: ['Yes', 'No'] });
  if (rewardRoot && nftTypes && nftSignificant && nftMarket && nftPurchase) {
    safeAdd(samples, graph, 'balanced_supplemental', 'nft_low_emphasis', [
      answer(rewardRoot, 'Yes'), answer(nftTypes, nftLabel), answer(nftSignificant, 'No'), answer(nftMarket, 'No'), answer(nftPurchase, 'No'),
    ], { topic: 'monetization' });
    safeAdd(samples, graph, 'balanced_supplemental', 'nft_marketplace_purchases', [
      answer(rewardRoot, 'Yes'), answer(nftTypes, nftLabel), answer(nftSignificant, 'Yes'), answer(nftMarket, 'Yes'), answer(nftPurchase, 'Yes'),
    ], { topic: 'monetization' });
  }

  const ageRestricted = topicRoot(graph, ['promoting or selling items', 'age-restricted']);
  const alcoholTobacco = findQuestion(graph, { text: ['promoting alcohol or tobacco'], labels: ['Yes', 'No'] });
  const otherRestricted = findQuestion(graph, { text: ['other age-restricted activities'], labels: ['Yes', 'No'] });
  if (ageRestricted && alcoholTobacco && otherRestricted) {
    safeAdd(samples, graph, 'balanced_supplemental', 'promote_alcohol_or_tobacco', [answer(ageRestricted, 'Yes'), answer(alcoholTobacco, 'Yes'), answer(otherRestricted, 'No')], { topic: 'age_restricted_commerce' });
    safeAdd(samples, graph, 'balanced_supplemental', 'promote_other_restricted_items', [answer(ageRestricted, 'Yes'), answer(alcoholTobacco, 'No'), answer(otherRestricted, 'Yes')], { topic: 'age_restricted_commerce' });
  }

  for (const [name, text, topic] of [
    ['web_browser', ['web browser or search engine'], 'utility'],
    ['news_or_education', ['news or educational product'], 'utility'],
  ]) {
    const root = topicRoot(graph, text);
    if (root) safeAdd(samples, graph, 'balanced_supplemental', name, [answer(root, 'Yes')], { topic });
  }
}

function addCrudeHumor(samples, graph) {
  const gate = contentGateAnswers(graph);
  const root = topicRoot(graph, ['bodily functions', 'humorous purposes']);
  const details = findByOptionLabels(graph, ['Mucus, belching, flatulence sounds'], { type: 'checkbox' });
  if (!root || !details) return;
  for (const [name, label] of [
    ['crude_humor_mild', 'Mucus, belching, flatulence sounds'],
    ['crude_humor_vomit_feces', 'Flatulence (with depiction of "flatulence cloud"), whimsical depictions of feces ("poo coils"), vomiting'],
    ['crude_humor_realistic_waste', 'Urination, urine, realistically depicted feces'],
    ['crude_humor_defecation', 'Act of human defecation visually depicted'],
  ]) {
    if (hasOption(details, label)) safeAdd(samples, graph, 'balanced_supplemental', name, [...gate, answer(root, 'Yes'), answer(details, label)], { topic: 'crude_humor' });
  }
}

function buildBalancedSamples(graph) {
  const samples = [];
  safeAdd(samples, graph, 'baseline', 'baseline', []);
  addViolence(samples, graph);
  addFear(samples, graph);
  addSexualContent(samples, graph);
  addGambling(samples, graph);
  addLanguage(samples, graph);
  addSubstances(samples, graph);
  addUgcSafety(samples, graph);
  addCatalogContent(samples, graph);
  addCatalogRestrictions(samples, graph);
  addCommerceAndUtility(samples, graph);
  addCrudeHumor(samples, graph);

  return samples
    .filter((sample) => !sample.skipped)
    .map((sample, index) => ({
      ...sample,
      sampleId: `${sample.categorySlug}_balanced_${String(index + 1).padStart(5, '0')}`,
    }));
}

async function loadGraphs() {
  const manifestPath = `${config.categoryRoot}/manifest.json`;
  const categories = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8')).categories || []
    : [
        { slug: 'game', category: 'Game' },
        { slug: 'social_or_communication', category: 'Social or Communication' },
        { slug: 'all_other_app_types', category: 'All Other App Types' },
      ];
  const graphs = [];
  for (const categoryInfo of categories) {
    const annotatedPath = `${config.categoryRoot}/${categoryInfo.slug}/question_graph_risk_annotated.json`;
    const fallbackPath = `${config.categoryRoot}/${categoryInfo.slug}/question_graph.json`;
    const graphPath = existsSync(annotatedPath) ? annotatedPath : fallbackPath;
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    graphs.push({ graph, graphPath, slug: categoryInfo.slug });
  }
  return graphs;
}

async function main() {
  await mkdir(config.outDir, { recursive: true });
  const allSamples = [];
  const summary = {
    generatedAt: new Date().toISOString(),
    categoryRoot: resolve(config.categoryRoot),
    outDir: resolve(config.outDir),
    categories: [],
  };

  for (const { graph, graphPath, slug: categorySlug } of await loadGraphs()) {
    const samples = buildBalancedSamples(graph);
    const samplePath = `${config.outDir}/${categorySlug}_balanced_samples.jsonl`;
    await writeFile(samplePath, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
    allSamples.push(...samples);
    summary.categories.push({
      category: graph.category,
      categorySlug,
      graphPath: resolve(graphPath),
      samplePath: resolve(samplePath),
      sampleCount: samples.length,
      strategyCounts: samples.reduce((acc, sample) => {
        acc[sample.strategy] = (acc[sample.strategy] || 0) + 1;
        return acc;
      }, {}),
      topicCounts: samples.reduce((acc, sample) => {
        const topic = sample.meta.topic || 'baseline';
        acc[topic] = (acc[topic] || 0) + 1;
        return acc;
      }, {}),
    });
  }

  const allPath = `${config.outDir}/balanced_samples.jsonl`;
  await writeFile(allPath, allSamples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  summary.allSamplesPath = resolve(allPath);
  summary.totalSamples = allSamples.length;
  await writeFile(`${config.outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
