'use strict';

// embedding.test.js — cosine 数学性质、keyOf 稳定性、无 QWEN_KEY 时全链路降级（零网络）
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// RAG_DATA_ROOT 必须在 require 前设置（模块加载时定位缓存文件），把磁盘缓存隔离到临时目录
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-embed-'));
process.env.RAG_DATA_ROOT = TMP_ROOT;
delete process.env.QWEN_KEY; // 强制离线：isAvailable()===false，embed/embedMany 全部降级为 null

const embedding = require('../tools/embedding');

after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('isAvailable/getEmbeddingConfig: 无 QWEN_KEY 时能力不可用且配置为 null', () => {
  assert.equal(embedding.isAvailable(), false);
  assert.equal(embedding.getEmbeddingConfig(), null);
});

test('cosine: 对称、自相似为 1、正交为 0', () => {
  const a = [1, 2, 3];
  const b = [3, 1, 2];
  const cosAB = embedding.cosine(a, b);
  const cosBA = embedding.cosine(b, a);
  assert.ok(Math.abs(cosAB - cosBA) < 1e-12, 'cosine 应对称');
  assert.ok(Math.abs(embedding.cosine(a, a) - 1) < 1e-12, '自身相似度为 1');
  assert.ok(cosAB > 0 && cosAB < 1);
  assert.equal(embedding.cosine([1, 0], [0, 1]), 0, '正交向量相似度为 0');
});

test('cosine: 维度不匹配、零向量、空输入返回 0', () => {
  assert.equal(embedding.cosine([1], [1, 2]), 0);
  assert.equal(embedding.cosine([0, 0], [1, 1]), 0);
  assert.equal(embedding.cosine(null, [1, 2]), 0);
  assert.equal(embedding.cosine([1, 2], undefined), 0);
});

test('keyOf: 输出稳定、24 位十六进制、不同文本不同键', () => {
  const k1 = embedding.keyOf('同一文本');
  assert.equal(k1, embedding.keyOf('同一文本'), '同文本同键');
  assert.match(k1, /^[0-9a-f]{24}$/);
  assert.notEqual(k1, embedding.keyOf('另一文本'));
  // 与 sha1(model + '\n' + text) 的一致性交叉验证
  const expected = crypto.createHash('sha1')
    .update(embedding.MODEL + '\n' + '同一文本', 'utf8').digest('hex').slice(0, 24);
  assert.equal(k1, expected);
});

test('embed/embedMany: 无 key 时全部降级为 null，不发起任何请求', async () => {
  assert.equal(await embedding.embed('任何文本'), null);
  assert.equal(await embedding.embed(''), null, '空文本直接 null');
  assert.deepEqual(await embedding.embedMany(['a', 'b']), [null, null]);
  assert.deepEqual(await embedding.embedMany([]), []);
});

test('缓存: storeCached/getCached 进程内往返，embedMany 命中缓存零请求', () => {
  assert.equal(embedding.getCached(''), null);
  assert.equal(embedding.getCached('不存在的内容'), null);

  embedding.storeCached('缓存文本样本', [0.1, 0.2, 0.3]);
  assert.deepEqual(embedding.getCached('缓存文本样本'), [0.1, 0.2, 0.3]);

  embedding.storeCached('忽略非数组向量', 'not-a-vector');
  assert.equal(embedding.getCached('忽略非数组向量'), null, '非法向量不写入缓存');
});

test('embedMany: 已缓存文本直接复用向量', async () => {
  embedding.storeCached('批量缓存文本', [1, 2, 3]);
  const out = await embedding.embedMany(['批量缓存文本', '未缓存文本']);
  assert.deepEqual(out[0], [1, 2, 3]);
  assert.equal(out[1], null);
});

test('saveCache: 缓存落盘到 RAG_DATA_ROOT 指定的临时目录', () => {
  embedding.storeCached('落盘文本', [4, 5, 6]);
  embedding.saveCache();
  const cacheFile = path.join(TMP_ROOT, 'embeddings-cache.json');
  assert.ok(fs.existsSync(cacheFile));
  const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(parsed.model, embedding.MODEL);
  assert.deepEqual(parsed.embeddings[embedding.keyOf('落盘文本')], [4, 5, 6]);
});
