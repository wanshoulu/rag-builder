'use strict';

// bm25-engine.test.js — 中文 bigram 分词、英文词边界、BM25 排序、摘要截取
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BM25Engine } = require('../tools/bm25-engine');

/** 按引擎公开字段手工建索引（与 rag-engine._buildKeywordIndex 同构） */
function addDoc(engine, id, title, content) {
  const tokens = engine.tokenize(content);
  tokens.forEach((t) => {
    if (!engine.index.has(t)) engine.index.set(t, []);
    engine.index.get(t).push(id);
  });
  engine.documents.push({ id, title, content, tokens });
}

test('tokenize: 中文生成完整词 + CJK bigram + 单字', () => {
  const engine = new BM25Engine();
  assert.deepEqual(engine.tokenize('中文分词'), [
    '中文分词', '中文', '文分', '分词', '中', '文', '分', '词',
  ]);
});

test('tokenize: 英文按词边界切分并统一小写、剔除标点', () => {
  const engine = new BM25Engine();
  assert.deepEqual(engine.tokenize('Hello, World! foo-bar'), ['hello', 'world', 'foo', 'bar']);
  assert.deepEqual(engine.tokenize('Learning to rank'), ['learning', 'to', 'rank']);
  assert.deepEqual(engine.tokenize('a b'), [], '单字符英文词被过滤');
  assert.deepEqual(engine.tokenize('!!! ,,, '), [], '纯标点不产生 token');
  assert.deepEqual(engine.tokenize(null), [], '空输入返回空数组');
});

test('tokenize: 中英混排各自产出正确 token', () => {
  const engine = new BM25Engine();
  const tokens = engine.tokenize('RAG 检索引擎');
  assert.ok(tokens.includes('rag'));
  assert.ok(tokens.includes('检索引擎'));
  assert.ok(tokens.includes('检索') && tokens.includes('索引') && tokens.includes('引擎'));
});

test('search: BM25 排序合理 — 高频文档靠前，无命中文档不出现', () => {
  const engine = new BM25Engine();
  addDoc(engine, 'd1', '量子计算详解',
    '量子计算是一种利用量子力学原理进行计算的技术。量子比特可以叠加。量子纠缠是量子计算的核心资源。');
  addDoc(engine, 'd2', '经典与量子',
    '经典计算机使用比特进行运算，与量子计算有明显区别。');
  addDoc(engine, 'd3', '生活随笔',
    '今天天气很好，我们去公园散步，阳光洒在草地上。');

  const results = engine.search('量子计算', { topK: 10 });
  assert.ok(results.length === 2, '应只返回两个命中文档');
  assert.equal(results[0].id, 'd1', '命中更多的文档应排名第一');
  assert.equal(results[1].id, 'd2');
  assert.ok(results[0].score > results[1].score, '分数严格递减');
  results.forEach((r) => {
    assert.ok(r.score > 0);
    assert.ok(typeof r.title === 'string' && r.title.length > 0);
    assert.ok(typeof r.snippet === 'string' && r.snippet.length > 0);
  });
});

test('search: topK 限制返回数量', () => {
  const engine = new BM25Engine();
  for (let i = 1; i <= 5; i++) {
    // 纯 CJK 连续串才能产生 bigram，数字不能拼接在中文词内
    addDoc(engine, 'doc' + i, '文档' + i, '共享关键词' + '内容彼此不同'.repeat(i));
  }
  const results = engine.search('共享关键词', { topK: 3 });
  assert.ok(results.length === 3);
  results.forEach((r) => assert.ok(r.score > 0));
});

test('search: 空索引返回空数组，reset 清空状态', () => {
  const engine = new BM25Engine();
  assert.deepEqual(engine.search('任意查询'), []);
  addDoc(engine, 'x', 'X', '一些内容。');
  engine.reset();
  assert.equal(engine.documents.length, 0);
  assert.equal(engine.index.size, 0);
  assert.deepEqual(engine.search('一些内容'), []);
});

test('getSnippet: 命中位置在中段时前后加省略号并包含查询词', () => {
  const engine = new BM25Engine();
  const text = 'a'.repeat(60) + '目标关键词' + 'b'.repeat(200);
  const snippet = engine.getSnippet(text, '目标关键词');
  assert.ok(snippet.startsWith('...'), '中段命中应以省略号开头');
  assert.ok(snippet.includes('目标关键词'));
  assert.ok(snippet.endsWith('...'), '后方仍有内容应以省略号结尾');
});

test('getSnippet: 命中在开头无前导省略号；未命中回退为前 N 字符加省略号', () => {
  const engine = new BM25Engine();
  const head = engine.getSnippet('目标关键词' + 'c'.repeat(300), '目标关键词');
  assert.ok(!head.startsWith('...'));
  assert.ok(head.includes('目标关键词'));

  const miss = engine.getSnippet('abcdef', 'zzz');
  assert.equal(miss, 'abcdef...');

  const bounded = engine.getSnippet('x'.repeat(500), 'zzz', 50);
  assert.equal(bounded, 'x'.repeat(50) + '...', 'maxLength 应约束截取长度');
});
