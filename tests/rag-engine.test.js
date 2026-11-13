'use strict';

// rag-engine.test.js — 临时 KB 全链路：buildIndex → search → verifyCache → incrementalUpdate → removeDocument
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { RAGEngine } = require('../tools/rag-engine');

// 强制离线：无 key 时 RAGEngine 自动走 TF-IDF/BM25 关键词兜底，绝不发起网络请求
delete process.env.QWEN_KEY;

const KB_DIR = fs.mkdtempSync(path.join(__dirname, '.tmp-kb-'));
const PROJECT = 'mykb';
const ctx = {};

function projectPath() {
  return path.join(KB_DIR, PROJECT);
}

function readCache() {
  return JSON.parse(fs.readFileSync(path.join(projectPath(), '.rag-cache.json'), 'utf-8'));
}

before(() => {
  fs.mkdirSync(projectPath());
  // 注意：chunker 默认 minChunkSize=100，每个 markdown 小节需超过 100 字符才不会整节被丢弃
  fs.writeFileSync(path.join(projectPath(), 'doc-a.md'),
    '# 量子计算入门\n\n## 概述\n'
    + '量子计算利用量子比特的叠加与纠缠进行并行计算，在某些问题上具有指数级加速潜力。'.repeat(4)
    + '\n\n## 应用\n'
    + '量子密钥分发与量子化学模拟是量子计算最重要的两个应用方向。'.repeat(4));
  fs.writeFileSync(path.join(projectPath(), 'doc-b.txt'),
    '向量数据库实践指南\n'
    + '向量数据库负责存储文本嵌入向量，并提供高效的近似最近邻检索能力，是 RAG 系统的核心存储组件。'.repeat(4));
});

after(() => {
  fs.rmSync(KB_DIR, { recursive: true, force: true });
});

test('buildIndex: 无 embeddingConfig 时走关键词模式并落盘 v6 缓存与 manifest', async () => {
  const engine = new RAGEngine({ kbRoot: KB_DIR });
  const stats = await engine.buildIndex(PROJECT);
  ctx.stats = stats;

  assert.equal(stats.project, PROJECT);
  assert.equal(stats.documents, 2);
  assert.ok(stats.chunks >= 1);
  assert.equal(stats.embedded, 0, '无 key 时不产生向量');
  assert.equal(stats.dim, 0);
  assert.ok(stats.timeMs >= 0);

  const cache = readCache();
  assert.equal(cache.version, 6);
  assert.match(cache.source_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(cache.configuration_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(cache.index_digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(cache.chunks.length === stats.chunks);

  const manifest = JSON.parse(fs.readFileSync(path.join(projectPath(), '.rag-manifest.json'), 'utf-8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['doc-a.md', 'doc-b.txt']);
});

test('buildIndex: 二次构建命中缓存且 stats 一致', async () => {
  const engine = new RAGEngine({ kbRoot: KB_DIR });
  const stats = await engine.buildIndex(PROJECT);
  assert.equal(stats.documents, ctx.stats.documents);
  assert.equal(stats.chunks, ctx.stats.chunks);
  assert.equal(stats.source_digest, ctx.stats.source_digest);
  ctx.engine = engine;
});

test('search: mode=keyword 命中正确文档并返回非空 snippet', async () => {
  const results = await ctx.engine.search('量子比特 叠加', { mode: 'keyword', topK: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].docId, 'doc-a.md');
  results.forEach((r) => {
    assert.ok(typeof r.score === 'number' && r.score >= 0);
    assert.ok(r.snippet.length > 0);
    assert.match(r.id, /^doc-[ab]\.(md|txt)#chunk\d+$/);
  });
});

test('search: mode=hybrid 无向量时回退关键词单路', async () => {
  const results = await ctx.engine.search('近似最近邻检索', { mode: 'hybrid', topK: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].docId, 'doc-b.txt');
});

test('verifyCache: 用 buildIndex 返回的 digest 校验通过，篡改后失败', () => {
  const valid = ctx.engine.verifyCache(PROJECT, ctx.stats);
  assert.equal(valid.valid, true);
  assert.equal(valid.code, undefined);
  assert.equal(valid.stats.chunks, ctx.stats.chunks);
  assert.equal(valid.stats.documents, 2);

  const tampered = ctx.engine.verifyCache(PROJECT, {
    source_digest: 'sha256:' + '0'.repeat(64),
    configuration_digest: 'sha256:' + '0'.repeat(64),
    index_digest: 'sha256:' + '0'.repeat(64),
  });
  assert.equal(tampered.valid, false);
  assert.equal(tampered.code, 'CACHE_CERTIFICATION_MISMATCH');

  const missing = ctx.engine.verifyCache('no-such-project', undefined);
  assert.equal(missing.valid, false);
  assert.equal(missing.code, 'CACHE_NOT_FOUND');
});

test('incrementalUpdate: 新增文档后被检出且可检索', async () => {
  fs.writeFileSync(path.join(projectPath(), 'doc-c.md'),
    '# 知识图谱\n\n' + '知识图谱以实体和关系组织信息，与向量检索形成互补。'.repeat(10));

  const engine = new RAGEngine({ kbRoot: KB_DIR });
  const result = await engine.incrementalUpdate(PROJECT);
  // 源变化后要么走增量（added:1）要么重建（documents:3），两者都应反映新文档
  assert.ok(result.added === 1 || result.documents === 3,
    '增量结果应包含新文档: ' + JSON.stringify(result));

  const hits = await engine.search('知识图谱 实体关系', { mode: 'keyword', topK: 5 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].docId, 'doc-c.md');
  ctx.engine = engine;
});

test('removeDocument: 删除指定文档分块并同步缓存', () => {
  const before = readCache().chunks.length;
  assert.ok(before >= 1);

  const result = ctx.engine.removeDocument(PROJECT, 'doc-b.txt');
  assert.ok(result.removed >= 1);
  assert.equal(result.remainingChunks, before - result.removed);

  const after = readCache();
  assert.ok(after.chunks.every((c) => c.docId !== 'doc-b.txt'));
  assert.equal(after.stats.chunks, after.chunks.length);

  const unknown = ctx.engine.removeDocument(PROJECT, 'not-exist.md');
  assert.equal(unknown.removed, 0);
});

test('getTaskStatus: 构建后留下 completed 任务记录，未知项目返回空列表', () => {
  const status = ctx.engine.getTaskStatus(PROJECT);
  assert.ok(Array.isArray(status.tasks) && status.tasks.length >= 1);
  assert.equal(status.tasks[0].status, 'completed');
  assert.deepEqual(ctx.engine.getTaskStatus('no-such-project'), { tasks: [] });
});
