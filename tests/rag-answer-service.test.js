'use strict';

// rag-answer-service.test.js — 注入 apiRoutes/requestImpl/rag.search 的三模式答案服务测试
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRagAnswerService } = require('../tools/knowledge-rag-answer-service');

// 强制离线：默认路由读 env key，删除后即便误用默认 apiRoutes 也不会发起真实请求
delete process.env.DEEPSEEK_KEY;

const MOCK_SOURCES = [
  { id: 'c1', docId: 'doc-a.md', title: '量子计算入门', score: 0.9, text: '量子计算利用量子比特进行并行计算。' },
  { id: 'c2', docId: 'doc-b.txt', title: '向量数据库', score: 0.6, text: '向量数据库支持近似最近邻检索。' },
];

function makeRag(results, capture) {
  return {
    search: async (query, options) => {
      if (capture) capture.push({ query, options });
      return results;
    },
  };
}

test('RETRIEVAL_ONLY: 无可用模型路由时只返回检索来源', async () => {
  const svc = createRagAnswerService({ apiRoutes: {} });
  const res = await svc.answer({ query: '什么是量子计算？', rag: makeRag(MOCK_SOURCES) });
  assert.equal(res.generation_mode, 'RETRIEVAL_ONLY');
  assert.equal(res.answer, null);
  assert.equal(res.sources.length, 2);
  assert.equal(res.sources[0].doc_id, 'doc-a.md');
  assert.equal(res.sources[0].rank, 1);
  assert.equal(res.sources[0].content, '量子计算利用量子比特进行并行计算。');
  assert.equal(res.error.code, 'RAG_ANSWER_GENERATOR_CONFIG_REQUIRED');
  assert.equal(res.generator_version, null);
});

test('GENERATED: 注入 mock LLM 后返回生成答案并携带引用来源', async () => {
  const captured = [];
  const routes = {
    'mock-model': { host: 'unused.invalid', path: '/v1/chat', model: 'mock-model', getKey: () => 'test-key' },
  };
  const requestImpl = async (input) => {
    captured.push(input);
    return { choices: [{ message: { content: '量子计算是一种并行计算范式 [1]。' } }] };
  };
  const svc = createRagAnswerService({ apiRoutes: routes, requestImpl });
  const res = await svc.answer({ query: '量子计算是什么', rag: makeRag(MOCK_SOURCES), model: 'mock-model' });

  assert.equal(res.generation_mode, 'GENERATED');
  assert.equal(res.answer, '量子计算是一种并行计算范式 [1]。');
  assert.equal(res.generator_version, 'mock-model');
  assert.equal(res.error, null);
  assert.ok(res.latency_ms >= 0);
  assert.equal(res.sources.length, 2);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].api_key, 'test-key');
  assert.equal(captured[0].model, 'mock-model');
  assert.ok(captured[0].timeout_ms >= 1000);
  assert.ok(captured[0].prompt.includes('## References'));
  assert.ok(captured[0].prompt.includes('量子计算利用量子比特进行并行计算。'));
  assert.ok(captured[0].prompt.includes('## Question\n量子计算是什么'));
});

test('NO_RESULT: 检索为空时直接返回无结果', async () => {
  const svc = createRagAnswerService({ apiRoutes: {} });
  const res = await svc.answer({ query: '完全查不到的问题', rag: makeRag([]) });
  assert.equal(res.generation_mode, 'NO_RESULT');
  assert.deepEqual(res.sources, []);
  assert.equal(res.answer, null);
  assert.equal(res.error, null);
});

test('FAILED: 检索抛错返回 SEARCH_FAILED', async () => {
  const svc = createRagAnswerService({ apiRoutes: {} });
  const res = await svc.answer({
    query: '查询',
    rag: { search: async () => { throw new Error('boom'); } },
  });
  assert.equal(res.generation_mode, 'FAILED');
  assert.equal(res.error.code, 'RAG_ANSWER_SEARCH_FAILED');
  assert.deepEqual(res.sources, []);
});

test('FAILED: 生成器抛错返回 GENERATION_FAILED 且保留来源', async () => {
  const routes = {
    'mock-model': { host: 'unused.invalid', path: '/x', model: 'mock-model', getKey: () => 'k' },
  };
  const svc = createRagAnswerService({
    apiRoutes: routes,
    requestImpl: async () => { throw new Error('model down'); },
  });
  const res = await svc.answer({ query: '查询', rag: makeRag(MOCK_SOURCES), model: 'mock-model' });
  assert.equal(res.generation_mode, 'FAILED');
  assert.equal(res.error.code, 'RAG_ANSWER_GENERATION_FAILED');
  assert.equal(res.sources.length, 2);
});

test('入参校验: 空 query 与缺失 rag 依赖分别抛出对应错误码', async () => {
  const svc = createRagAnswerService({ apiRoutes: {} });
  await assert.rejects(
    () => svc.answer({ query: '   ', rag: makeRag(MOCK_SOURCES) }),
    (err) => { assert.equal(err.code, 'RAG_ANSWER_QUERY_INVALID'); return true; },
  );
  await assert.rejects(
    () => svc.answer({ query: '合法问题' }),
    (err) => { assert.equal(err.code, 'RAG_ANSWER_RAG_INVALID'); return true; },
  );
});

test('参数透传: top_k 钳制到 [1,5]、search_mode/rerank 原样传给 rag.search', async () => {
  const captured = [];
  const svc = createRagAnswerService({ apiRoutes: {} });

  await svc.answer({ query: 'q', top_k: 99, search_mode: 'keyword', rerank: true, rag: makeRag(MOCK_SOURCES, captured) });
  assert.equal(captured[0].options.topK, 5);
  assert.equal(captured[0].options.mode, 'keyword');
  assert.equal(captured[0].options.rerank, true);

  await svc.answer({ query: 'q', top_k: 0, rag: makeRag(MOCK_SOURCES, captured) });
  assert.equal(captured[1].options.topK, 1);

  await svc.answer({ query: 'q', top_k: 'not-a-number', rag: makeRag(MOCK_SOURCES, captured) });
  assert.equal(captured[2].options.topK, 5);
});
