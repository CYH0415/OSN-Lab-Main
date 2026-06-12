const root = process.env.RATING_ARTIFACT_ROOT || 'rating_artifacts';

export const RATING_ARTIFACT_ROOT = root;
export const RATING_SAMPLE_ROOT = process.env.RATING_SAMPLE_ROOT || `${root}/samples`;
export const RATING_RESULT_ROOT = process.env.RATING_RESULT_ROOT || `${root}/results`;
export const RATING_AUTONOMOUS_ROOT =
  process.env.RATING_AUTONOMOUS_ROOT || `${root}/autonomous`;
export const RATING_SMOKE_ROOT = process.env.RATING_SMOKE_ROOT || `${root}/smoke`;
export const RATING_WORK_ROOT = process.env.RATING_WORK_ROOT || `${root}/work`;

export const RATING_AUTONOMOUS_DIR = `${RATING_AUTONOMOUS_ROOT}/rating_autonomous`;
export const RATING_SMOKE_DIR = `${RATING_SMOKE_ROOT}/rating_smoke`;

export function ratingSampleDir(name) {
  return `${RATING_SAMPLE_ROOT}/${name}`;
}

export function ratingResultDir(name) {
  return `${RATING_RESULT_ROOT}/${name}`;
}

export function ratingWorkDir(name) {
  return `${RATING_WORK_ROOT}/${name}`;
}
