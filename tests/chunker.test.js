'use strict';

// chunker.test.js — 分块策略边界测试（长文本切分、短文本不丢、markdown 标题分块）
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chunkDocument, chunkDocuments, previewChunks } = require('../tools/chunker');

test('chunkDocument: 空内容、纯空白、仅 frontmatter 均返回空数组', () => {
  assert.deepEqual(chunkDocument('', {}), []);
  assert.deepEqual(chunkDocument('   \n\t  ', {}), []);
  assert.deepEqual(chunkDocument('---\ntitle: x\n---\n', {}), []);
});

test('chunkDocument: fixed_size 长文本切分 — 多块、每块不超限、首尾覆盖、相邻块重叠', () => {
  const text = '这是用于分块测试的句子。'.repeat(100); // 1200 chars, no whitespace
  const chunks = chunkDocument(text, { strategy: 'fixed_size', chunkSize: 100, overlap: 10, minChunkSize: 5 });
  assert.ok(chunks.length >= 10, '应切出多个块，实际 ' + chunks.length);
  chunks.forEach((c) => {
    assert.ok(c.charCount <= 100, '单块不超过 chunkSize');
    assert.ok(c.charCount >= 5, '单块不小于 minChunkSize');
    assert.equal(c.tokenEstimate, Math.ceil(c.charCount / 3));
  });
  assert.ok(text.startsWith(chunks[0].text), '首块从原文开头开始');
  assert.ok(text.endsWith(chunks[chunks.length - 1].text), '末块以原文结尾收束');
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.ok(chunks[i + 1].text.startsWith(chunks[i].text.slice(-10)), '相邻块应有 overlap 重叠');
  }
});

test('chunkDocument: 短文本不丢 — minChunkSize 足够小时整段保留', () => {
  const short = '只有一句话的短文本，不应该被丢弃。';
  const chunks = chunkDocument(short, { strategy: 'fixed_size', chunkSize: 1024, overlap: 10, minChunkSize: 5 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, short);
  assert.equal(chunks[0].charCount, short.length);
});

test('chunkDocument: markdown 策略按 ## 标题分块并挂 heading', () => {
  const md = '# 标题\n\n开头介绍段落，包含足够多的文字用于满足最小块大小的要求。\n\n## 第一部分\n'
    + '第一部分的内容，讲述量子计算的基础知识。'.repeat(6)
    + '\n\n## 第二部分\n'
    + '第二部分的内容，讲述向量数据库的实践方法。'.repeat(6);
  const chunks = chunkDocument(md, { strategy: 'markdown', chunkSize: 400, minChunkSize: 20 });
  const first = chunks.find((c) => c.heading === '第一部分');
  const second = chunks.find((c) => c.heading === '第二部分');
  assert.ok(first, '应产出 heading=第一部分 的块');
  assert.ok(first.text.includes('## 第一部分'), '块文本包含标题行');
  assert.ok(first.text.includes('量子计算'), '块文本包含节内容');
  assert.ok(second && second.text.includes('向量数据库'));
  assert.ok(chunks[0].text.startsWith('# 标题'), '首个块保留标题前的前置内容');
});

test('chunkDocument: markdown 超大章节会被子分块且共享同一 heading', () => {
  const md = '## 大节\n' + 'x'.repeat(800);
  const chunks = chunkDocument(md, { strategy: 'markdown', chunkSize: 300, minChunkSize: 50 });
  assert.ok(chunks.length >= 2, '超大章节应切成多块');
  chunks.forEach((c) => {
    assert.equal(c.heading, '大节');
    assert.ok(c.charCount <= 300);
    assert.match(c.text, /^(## 大节\n)?x+$/, '子块由标题行+填充字符组成');
  });
});

test('chunkDocument: sentence 策略按中英文句号边界切分且内容不丢', () => {
  const text = '第一句话。第二句话！第三句话？第四句话.';
  const chunks = chunkDocument(text, { strategy: 'sentence', chunkSize: 15, overlap: 128, minChunkSize: 4 });
  assert.equal(chunks.length, 2);
  const all = chunks.map((c) => c.text).join('|');
  ['第一句话。', '第二句话！', '第三句话？', '第四句话.'].forEach((s) => {
    assert.ok(all.includes(s), '句子 ' + s + ' 不应丢失');
  });
});

test('chunkDocument: paragraph 策略按双换行切分', () => {
  const text = '段落甲，内容较多。\n\n段落乙，内容也不少。';
  const chunks = chunkDocument(text, { strategy: 'paragraph', chunkSize: 19, minChunkSize: 5 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, '段落甲，内容较多。');
  assert.equal(chunks[1].text, '段落乙，内容也不少。');
});

test('chunkDocument: 每个块都附带 metadata（策略/类型/来源）', () => {
  const chunks = chunkDocument('第一句话。第二句话！第三句话？第四句话。第五句话。'.repeat(4), {
    strategy: 'sentence', chunkSize: 30, minChunkSize: 5,
    metadata: { type: 'faq', fileName: 'faq.md' },
  });
  assert.ok(chunks.length >= 1);
  chunks.forEach((c) => {
    assert.equal(c.metadata.chunkStrategy, 'sentence');
    assert.equal(c.metadata.docType, 'faq');
    assert.equal(c.metadata.docSource, 'faq.md');
    assert.ok(typeof c.metadata.parsedAt === 'string');
  });
});

test('chunkDocuments: 多文档展平并写入 docId/docTitle/chunkIndex/唯一 id', () => {
  const docs = [
    { id: 'd1.md', title: 'Doc One', content: '第一篇文档的内容，重复填充以超过最小块大小。'.repeat(6) },
    { id: 'd2.md', title: 'Doc Two', content: '第二篇文档的内容，同样重复填充。'.repeat(6) },
  ];
  const all = chunkDocuments(docs, { strategy: 'fixed_size', chunkSize: 50, overlap: 5, minChunkSize: 5 });
  assert.ok(all.length >= 2);
  const ids = new Set();
  all.forEach((c, i) => {
    assert.ok(['d1.md', 'd2.md'].includes(c.docId));
    assert.equal(c.docTitle, c.docId === 'd1.md' ? 'Doc One' : 'Doc Two');
    assert.equal(c.chunkIndex, i);
    assert.equal(c.id, c.docId + '#chunk' + i);
    assert.ok(!ids.has(c.id), 'chunk id 应唯一');
    ids.add(c.id);
  });
});

test('previewChunks: 返回统计信息、警告与采样且 chunks 与 chunkDocument 一致', () => {
  const text = '这是用于预览测试的句子。'.repeat(80);
  const preview = previewChunks(text, { strategy: 'fixed_size', chunkSize: 120, overlap: 10, minChunkSize: 5 });
  assert.equal(preview.totalChunks, preview.chunks.length);
  assert.ok(preview.totalChunks >= 5);
  assert.equal(preview.totalChars, preview.chunks.reduce((s, c) => s + c.charCount, 0));
  assert.ok(preview.avgChars > 0);
  assert.ok(preview.minChars >= 5 && preview.maxChars <= 120);
  assert.ok(Array.isArray(preview.warnings));
  assert.ok(preview.samples.length <= 5 && preview.samples.length > 0);
  assert.ok('chunks' in preview && 'samples' in preview && 'warnings' in preview);
});
