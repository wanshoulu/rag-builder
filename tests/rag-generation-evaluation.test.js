'use strict';

// rag-generation-evaluation.test.js — 评测指标纯函数（引用覆盖率、用例判定）
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DEFAULT_THRESHOLDS, computeCitationCoverage, evaluateCaseResult } = require('../tools/knowledge-rag-generation-evaluation');

test('DEFAULT_THRESHOLDS: 冻结且包含五个已知阈值', () => {
  assert.ok(Object.isFrozen(DEFAULT_THRESHOLDS));
  assert.equal(DEFAULT_THRESHOLDS.answer_correctness, 0.80);
  assert.equal(DEFAULT_THRESHOLDS.answer_relevancy, 0.80);
  assert.equal(DEFAULT_THRESHOLDS.groundedness, 0.85);
  assert.equal(DEFAULT_THRESHOLDS.citation_coverage, 0.90);
  assert.equal(DEFAULT_THRESHOLDS.refusal_accuracy, 0.95);
});

test('computeCitationCoverage: 全部 claim 带有效引用时为 1', () => {
  const coverage = computeCitationCoverage('结论 A 成立 [1]。', [{ rank: 1 }]);
  assert.equal(coverage, 1);
});

test('computeCitationCoverage: 部分 claim 有引用时按比例计', () => {
  const coverage = computeCitationCoverage('Alpha beta gamma [1]. Delta epsilon zeta.', [{ rank: 1 }, { rank: 2 }]);
  assert.equal(coverage, 0.5);
});

test('computeCitationCoverage: 引用序号超出来源范围不计入', () => {
  assert.equal(computeCitationCoverage('某结论成立 [9]。', [{ rank: 1 }]), 0);
  assert.equal(computeCitationCoverage('某结论成立 [2]。', [{ rank: 1 }]), 0);
});

test('computeCitationCoverage: 空答案或过短 claim 返回 0', () => {
  assert.equal(computeCitationCoverage('', [{ rank: 1 }]), 0);
  assert.equal(computeCitationCoverage(null, [{ rank: 1 }]), 0);
  assert.equal(computeCitationCoverage('ok [1]', [{ rank: 1 }]), 0, '去掉引用后不足 3 字符的 claim 不计');
});

test('evaluateCaseResult: 非 GENERATED 模式不做判定，指标为 null', () => {
  const result = evaluateCaseResult({
    case_id: 'c1',
    query: 'q',
    generation: { generation_mode: 'RETRIEVAL_ONLY', answer: null, sources: [] },
  });
  assert.equal(result.generation_mode, 'RETRIEVAL_ONLY');
  assert.equal(result.passed, false);
  assert.equal(result.answer_correctness, null);
  assert.equal(result.citation_coverage, null);
  assert.equal(result.error, null);
  assert.ok(Object.isFrozen(result));
});

test('evaluateCaseResult: 判官齐全且引用完整时通过并写入全部指标', () => {
  const result = evaluateCaseResult({
    case_id: 'case-pass',
    query: '混合检索如何工作',
    judge: { answer_correctness: 0.95, answer_relevancy: 0.9, groundedness: 0.9 },
    generation: {
      generation_mode: 'GENERATED',
      answer: 'The system uses hybrid retrieval [1].',
      sources: [{ doc_id: 'd1', chunk_id: 'c1', title: 'T', rank: 1, score: 0.42 }],
      generator_version: 'deepseek-chat',
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.error, null);
  assert.equal(result.answer_correctness, 0.95);
  assert.equal(result.groundedness, 0.9);
  assert.equal(result.citation_coverage, 1);
  assert.equal(result.refusal_accuracy, null, '未声明 should_refuse 时不考核拒答');
  assert.equal(result.sources[0].doc_id, 'd1');
  assert.equal(result.sources[0].score, 0.42);
  assert.ok(Object.isFrozen(result));
});

test('evaluateCaseResult: 缺失判官返回 JUDGE_UNAVAILABLE 且不通过', () => {
  const result = evaluateCaseResult({
    case_id: 'case-no-judge',
    generation: { generation_mode: 'GENERATED', answer: '一个没有任何引用的答案。', sources: [] },
  });
  assert.equal(result.passed, false);
  assert.equal(result.error.code, 'RAG_GENERATION_EVALUATOR_JUDGE_UNAVAILABLE');
  assert.equal(result.answer_correctness, null);
});

test('evaluateCaseResult: 判官指标越界视为契约非法', () => {
  const result = evaluateCaseResult({
    case_id: 'case-bad-judge',
    judge: { answer_correctness: 1.5, answer_relevancy: 0.9, groundedness: 0.9 },
    generation: { generation_mode: 'GENERATED', answer: '答案 A [1]。', sources: [{ rank: 1 }] },
  });
  assert.equal(result.passed, false);
  assert.equal(result.error.code, 'RAG_GENERATION_EVALUATOR_JUDGE_CONTRACT_INVALID');
});

test('evaluateCaseResult: 指标低于阈值时不通过', () => {
  const result = evaluateCaseResult({
    case_id: 'case-low',
    judge: { answer_correctness: 0.95, answer_relevancy: 0.9, groundedness: 0.5 },
    generation: {
      generation_mode: 'GENERATED',
      answer: '答案有引用 [1]。',
      sources: [{ rank: 1 }],
    },
  });
  assert.equal(result.groundedness, 0.5);
  assert.equal(result.passed, false, 'groundedness 0.5 < 0.85 应不通过');
});

test('evaluateCaseResult: should_refuse 场景按拒答一致性计 refusal_accuracy', () => {
  const pass = evaluateCaseResult({
    case_id: 'case-refuse-ok',
    should_refuse: true,
    judge: { answer_correctness: 0.95, answer_relevancy: 0.9, groundedness: 0.9 },
    generation: {
      generation_mode: 'GENERATED',
      refused: true,
      answer: '证据不足，无法回答 [1]。',
      sources: [{ rank: 1 }],
    },
  });
  assert.equal(pass.refusal_accuracy, 1);
  assert.equal(pass.passed, true);

  const fail = evaluateCaseResult({
    case_id: 'case-refuse-miss',
    should_refuse: true,
    judge: { answer_correctness: 0.95, answer_relevancy: 0.9, groundedness: 0.9 },
    generation: {
      generation_mode: 'GENERATED',
      refused: false,
      answer: '证据不足，无法回答 [1]。',
      sources: [{ rank: 1 }],
    },
  });
  assert.equal(fail.refusal_accuracy, 0);
  assert.equal(fail.passed, false, 'refusal_accuracy 0 < 0.95 应不通过');
});
