'use strict';

// server.test.js — 启动测试实例（随机端口）验证健康检查、根路径重定向、未知路由 404
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

delete process.env.QWEN_KEY; // 离线兜底模式，与生产无 key 部署一致
process.env.PORT = '0';      // 随机高端口，避免与其他测试/服务冲突

const server = require('../server.js');

let port = 0;

function baseUrl() {
  return 'http://127.0.0.1:' + port;
}

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
  port = server.address().port;
  assert.ok(Number.isInteger(port) && port > 0, '应绑定到随机端口');
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('GET /healthz 返回 ok:true 且 service 为 rag-builder', async () => {
  const res = await fetch(baseUrl() + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'rag-builder');
  assert.ok(typeof body.version === 'string');
  assert.ok(typeof body.time === 'string');
  assert.ok(!Number.isNaN(Date.parse(body.time)));
});

test('GET /api/health 同样返回健康状态', async () => {
  const res = await fetch(baseUrl() + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'rag-builder');
});

test('GET / 以 302 重定向到 /tools/index.html', async () => {
  const res = await fetch(baseUrl() + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/tools/index.html');
});

test('GET /index.html 同样 302 重定向', async () => {
  const res = await fetch(baseUrl() + '/index.html', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/tools/index.html');
});

test('未知路由返回 404 JSON 错误', async () => {
  const res = await fetch(baseUrl() + '/definitely/not/a/route');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'NOT_FOUND');
});
