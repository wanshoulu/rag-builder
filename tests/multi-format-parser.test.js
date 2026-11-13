'use strict';

// multi-format-parser.test.js — getFileType 分类 + .md/.txt 直读解析（不含二进制格式）
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFile, getFileType, extractTablesFromText, extractTablesFromHtml } = require('../tools/multi-format-parser');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-parser-'));

before(() => {
  fs.writeFileSync(path.join(TMP, 'note.md'), '# 解析标题\n\n这是 markdown 正文内容。');
  fs.writeFileSync(path.join(TMP, 'note.txt'), '纯文本第一行\n纯文本第二行。');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('getFileType: 按扩展名正确分类', () => {
  assert.equal(getFileType('a.pdf'), 'pdf');
  assert.equal(getFileType('a.docx'), 'docx');
  assert.equal(getFileType('a.pptx'), 'pptx');
  assert.equal(getFileType('a.xlsx'), 'xlsx');
  assert.equal(getFileType('a.md'), 'markdown');
  assert.equal(getFileType('a.txt'), 'text');
  assert.equal(getFileType('a.csv'), 'csv');
  assert.equal(getFileType('a.json'), 'json');
  assert.equal(getFileType('a.xml'), 'xml');
  assert.equal(getFileType('a.html'), 'html');
  assert.equal(getFileType('a.htm'), 'html');
});

test('getFileType: 大小写不敏感且未知扩展名返回 unknown', () => {
  assert.equal(getFileType('README.MD'), 'markdown');
  assert.equal(getFileType('data.CSV'), 'csv');
  assert.equal(getFileType('archive.xyz'), 'unknown');
  assert.equal(getFileType('noext'), 'unknown');
});

test('parseFile: .md 直读解析，文本与元数据完整', async () => {
  const fp = path.join(TMP, 'note.md');
  const result = await parseFile(fp);
  assert.equal(result.text, '# 解析标题\n\n这是 markdown 正文内容。');
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.tables, []);
  assert.equal(result.metadata.fileName, 'note.md');
  assert.equal(result.metadata.filePath, fp);
  assert.equal(result.metadata.type, 'markdown');
  assert.equal(result.metadata.size, Buffer.byteLength(result.text));
  assert.match(result.metadata.hash, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(result.metadata.parsedAt)));
});

test('parseFile: .txt 直读解析且 hash 对同内容稳定', async () => {
  const fp = path.join(TMP, 'note.txt');
  const result = await parseFile(fp);
  assert.equal(result.metadata.type, 'text');
  assert.equal(result.text, '纯文本第一行\n纯文本第二行。');

  const again = await parseFile(fp);
  assert.equal(again.metadata.hash, result.metadata.hash, '同内容 hash 一致');
});

test('parseFile: 文件不存在时抛出 File not found', async () => {
  await assert.rejects(
    () => parseFile(path.join(TMP, 'missing.md')),
    (err) => assert.ok(err instanceof Error) || true,
  );
  await assert.rejects(
    () => parseFile(path.join(TMP, 'missing.md')),
    /File not found/,
  );
});

test('extractTablesFromText: 竖线表格转 markdown 并补分隔行', () => {
  const tables = extractTablesFromText('| 名称 | 数值 |\n| 量子 | 2 |\n\n普通段落，没有表格线。');
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.rowCount, 2);
  assert.equal(t.colCount, 2);
  const lines = t.markdown.split('\n');
  assert.equal(lines[0], '| 名称 | 数值 |');
  assert.match(lines[1], /^\| --- \| --- \|$/);
  assert.equal(lines[2], '| 量子 | 2 |');
});

test('extractTablesFromText: 无表格文本返回空数组', () => {
  assert.deepEqual(extractTablesFromText('普通段落一。\n普通段落二。'), []);
});

test('extractTablesFromHtml: table 转 markdown，剔除单元格内标签', () => {
  const html = '<table><tr><th>H1</th><th>H2</th></tr>'
    + '<tr><td><b>v1</b></td><td>v2</td></tr></table>';
  const tables = extractTablesFromHtml(html);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.rowCount, 2);
  assert.equal(t.colCount, 2);
  assert.ok(t.markdown.includes('| H1 | H2 |'));
  assert.ok(t.markdown.includes('| v1 | v2 |'));
  assert.equal(t.html, html);
});
