'use strict';

const DEFAULT_THRESHOLDS = Object.freeze({
  answer_correctness: 0.80,
  answer_relevancy: 0.80,
  groundedness: 0.85,
  citation_coverage: 0.90,
  refusal_accuracy: 0.95,
});

const REQUIRED_JUDGE_METRICS = ['answer_correctness', 'answer_relevancy', 'groundedness'];
const HARD_METRICS = ['answer_correctness', 'answer_relevancy', 'groundedness', 'citation_coverage'];

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function asText(value, fallback) {
  return typeof value === 'string' ? value : (fallback === undefined ? '' : fallback);
}

function publicError(error, fallbackCode, fallbackMessage) {
  if (!error && !fallbackCode) return null;
  const source = isRecord(error) ? error : {};
  const candidate = typeof source.code === 'string' ? source.code.trim() : '';
  const code = /^[A-Z][A-Z0-9_.-]{1,119}$/u.test(candidate)
    ? candidate
    : (fallbackCode || 'RAG_GENERATION_EVALUATOR_ERROR');
  return {
    code,
    message: fallbackMessage || 'Evaluation failed',
  };
}

function sourceMetadata(source, index) {
  const item = isRecord(source) ? source : {};
  const docId = item.doc_id !== undefined ? item.doc_id : (item.docId !== undefined ? item.docId : item.id);
  const chunkId = item.chunk_id !== undefined ? item.chunk_id : (item.chunkId !== undefined ? item.chunkId : item.id);
  const rank = Number(item.rank);
  const score = item.score;
  return {
    doc_id: docId === undefined || docId === null ? '' : String(docId).slice(0, 500),
    chunk_id: chunkId === undefined || chunkId === null ? '' : String(chunkId).slice(0, 500),
    title: item.title === undefined || item.title === null ? '' : String(item.title).slice(0, 300),
    rank: Number.isInteger(rank) && rank > 0 ? rank : index + 1,
    score: typeof score === 'number' && Number.isFinite(score) ? round4(score) : null,
  };
}

function publicSources(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 50).map(sourceMetadata);
}

function claimSegments(answer) {
  // Claims are sentence and clause units. Semicolons/newlines split independently
  // so a trailing citation cannot cover an unrelated preceding claim.
  return String(answer || '')
    .split(/(?<=[.!?。！？；;\n])\s*/u)
    .flatMap((sentence) => sentence.split(/\s*[；;\n]\s*/u))
    .map((claim) => claim.trim())
    .filter((claim) => claim.replace(/\[\d+\]/g, '').trim().length >= 3);
}

function computeCitationCoverage(answer, sources) {
  if (typeof answer !== 'string' || !answer.trim()) return 0;
  const validRanks = new Set(publicSources(sources).map((item) => item.rank));
  const claims = claimSegments(answer);
  if (!claims.length) return 0;
  const covered = claims.filter((claim) => {
    return Array.from(claim.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))
      .some((rank) => validRanks.has(rank));
  }).length;
  return round4(Math.max(0, Math.min(1, covered / claims.length)));
}

function validMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizeJudge(judge) {
  if (!isRecord(judge) || judge.error) {
    return { ok: false, code: 'RAG_GENERATION_EVALUATOR_JUDGE_UNAVAILABLE', message: 'RAG evaluator judge is unavailable' };
  }
  for (const key of REQUIRED_JUDGE_METRICS) {
    if (!Object.prototype.hasOwnProperty.call(judge, key) || !validMetric(judge[key])) {
      return { ok: false, code: 'RAG_GENERATION_EVALUATOR_JUDGE_CONTRACT_INVALID', message: 'RAG evaluator judge contract is invalid' };
    }
  }
  if (Object.prototype.hasOwnProperty.call(judge, 'refusal_accuracy') && !validMetric(judge.refusal_accuracy)) {
    return { ok: false, code: 'RAG_GENERATION_EVALUATOR_JUDGE_CONTRACT_INVALID', message: 'RAG evaluator judge contract is invalid' };
  }
  return {
    ok: true,
    answer_correctness: round4(judge.answer_correctness),
    answer_relevancy: round4(judge.answer_relevancy),
    groundedness: round4(judge.groundedness),
    refusal_accuracy: Object.prototype.hasOwnProperty.call(judge, 'refusal_accuracy')
      ? round4(judge.refusal_accuracy)
      : null,
  };
}

function refusalPhrase(answer) {
  if (typeof answer !== 'string' || !answer.trim()) return null;
  return /evidence\s+is\s+insufficient|insufficient\s+evidence|not\s+enough\s+evidence|unable\s+to\s+(?:answer|determine)|cannot\s+answer|证据不足|信息不足|无法回答|无法作答|没有足够证据/iu.test(answer);
}

function deriveRefusalAccuracy(expected, generation, answer, judgeRefusal) {
  if (typeof expected !== 'boolean') return null;
  if (typeof judgeRefusal === 'number') return judgeRefusal;
  if (typeof generation.refused === 'boolean') return generation.refused === expected ? 1 : 0;
  const refused = refusalPhrase(answer);
  if (refused === null) return expected ? 0 : 1;
  return refused === expected ? 1 : 0;
}

function effectiveThresholds(overrides) {
  const result = { ...DEFAULT_THRESHOLDS };
  if (!isRecord(overrides)) return result;
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    if (validMetric(overrides[key])) result[key] = overrides[key];
  }
  return result;
}

function baseEvidence(input, generation, mode) {
  const judge = isRecord(input.judge) ? input.judge : null;
  const expectedRefuse = typeof input.should_refuse === 'boolean' ? input.should_refuse : null;
  return {
    case_id: asText(input.case_id),
    query: asText(input.query),
    expected_answer: input.expected_answer === undefined ? null : asText(input.expected_answer, null),
    gold_facts: Array.isArray(input.gold_facts) ? input.gold_facts.filter((item) => typeof item === 'string').slice() : [],
    relevant_doc_ids: Array.isArray(input.relevant_doc_ids)
      ? input.relevant_doc_ids.filter((item) => typeof item === 'string').slice()
      : [],
    should_refuse: expectedRefuse,
    generation_mode: mode,
    answer: typeof generation.answer === 'string' ? generation.answer.trim() : null,
    sources: publicSources(generation.sources),
    generator_version: generation.generator_version === undefined ? null : asText(generation.generator_version, null),
    evaluator_version: judge && (judge.evaluator_version || judge.evaluatorVersion || judge.version)
      ? asText(judge.evaluator_version || judge.evaluatorVersion || judge.version, null)
      : null,
    answer_correctness: null,
    answer_relevancy: null,
    groundedness: null,
    citation_coverage: null,
    refusal_accuracy: null,
    passed: false,
    error: publicError(generation.error, null, 'RAG generation failed'),
  };
}

function evaluateCaseResult(input, thresholdOverrides) {
  const source = isRecord(input) ? input : {};
  const generation = isRecord(source.generation) ? source.generation : {};
  const mode = asText(generation.generation_mode || generation.mode, 'FAILED');
  const result = baseEvidence(source, generation, mode);
  if (mode !== 'GENERATED') return freezeDeep(result);

  const normalizedJudge = normalizeJudge(source.judge);
  const answerComplete = typeof generation.answer === 'string' && generation.answer.trim().length > 0;
  const generationComplete = !generation.error && answerComplete;
  if (!generationComplete || !normalizedJudge.ok) {
    if (!normalizedJudge.ok) {
      result.error = publicError(null, normalizedJudge.code, normalizedJudge.message);
    } else if (!result.error) {
      result.error = publicError(null, normalizedJudge.code || 'RAG_GENERATION_EVALUATOR_GENERATION_INCOMPLETE', normalizedJudge.message || 'RAG generation is incomplete');
    }
    return freezeDeep(result);
  }

  result.error = null;
  result.answer_correctness = normalizedJudge.answer_correctness;
  result.answer_relevancy = normalizedJudge.answer_relevancy;
  result.groundedness = normalizedJudge.groundedness;
  result.citation_coverage = computeCitationCoverage(result.answer, result.sources);
  result.refusal_accuracy = deriveRefusalAccuracy(
    result.should_refuse,
    generation,
    result.answer,
    normalizedJudge.refusal_accuracy,
  );

  const thresholds = effectiveThresholds(source.thresholds || thresholdOverrides);
  const required = HARD_METRICS.concat(result.should_refuse === null ? [] : ['refusal_accuracy']);
  result.passed = required.every((key) => typeof result[key] === 'number' && result[key] >= thresholds[key]);
  return freezeDeep(result);
}

module.exports = {
  DEFAULT_THRESHOLDS,
  computeCitationCoverage,
  evaluateCaseResult,
};
