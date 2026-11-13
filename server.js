'use strict';

/**
 * rag-builder — RAG 向量知识构建工具链（独立服务 + 独立前端）
 *
 * 从旧平台 routes/knowledge-studio.js 拆分出的独立部署入口：
 *   - 前端：tools/index.html 单文件应用，零 CDN
 *   - 后端：routes/rag-api.js 的 handleRagRequest 单入口（method+pathname 分发）
 *   - 数据：data/kb/<name>/ 即知识库（docs/*.md 文档 + .rag-cache.json 索引缓存），无数据库
 *
 * 路由族：
 *   /api/rag/*                RAG 主体：kbs/documents/preview/build/status/tasks/search/answer/chunks/docs-delete
 *
 * 环境变量（无 dotenv，直读 process.env.X || 默认）：
 *   PORT            监听端口（默认 3015，避开旧平台 3000 / graph-builder 3013 / llm-wiki-builder 3014）
 *   HOST            监听地址（默认 127.0.0.1）
 *   RAG_DATA_ROOT   数据根目录（默认 ./data，KB 落 data/kb/）
 *   QWEN_KEY        DashScope 嵌入密钥（未配置时 TF-IDF 关键词向量兜底，链路照常可用）
 *   DEEPSEEK_KEY    DeepSeek 生成密钥（未配置时 /api/rag/answer 返回 RETRIEVAL_ONLY）
 *   RAG_DEFAULT_ANSWER_MODEL  答案生成模型名（默认 deepseek-chat，须在 config/api-keys.js 注册）
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { handleRagRequest } = require('./routes/rag-api');
const { KB_ROOT } = require('./tools/rag-engine-pool');

const PORT = Number(process.env.PORT || 3015);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const TOOLS_ROOT = path.join(ROOT, 'tools');

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'application/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', path: filePath.replace(ROOT, '') });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/** 静态目录映射：URL 前缀 → 磁盘目录，path.resolve + startsWith 禁止路径穿越 */
function serveStatic(res, pathname, urlPrefix, diskRoot) {
  const rel = decodeURIComponent(pathname.slice(urlPrefix.length));
  const abs = path.resolve(diskRoot, rel);
  if (abs !== diskRoot && !abs.startsWith(diskRoot + path.sep)) {
    return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
  }
  return serveFile(res, abs);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  req.pathname = decodeURIComponent(u.pathname);
  const p = req.pathname;

  // 健康检查
  if (p === '/healthz' || p === '/api/health') {
    return sendJson(res, 200, {
      ok: true, service: 'rag-builder', version: '1.0.0',
      port: PORT, time: new Date().toISOString(),
      routes: ['/api/rag/*'],
      kbRoot: KB_ROOT,
      embeddingEnabled: !!process.env.QWEN_KEY,
    });
  }

  // 根路径落到 RAG 工作台
  if (p === '/' || p === '/index.html') {
    res.writeHead(302, { Location: '/tools/index.html' });
    return res.end();
  }
  if (p === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // ── API 分发 ──
  // RAG 主体端点（kbs/documents/preview/build/status/tasks/search/answer/chunks/chunks-update/docs-delete）
  if (p === '/api/rag' || p.startsWith('/api/rag/')) {
    return handleRagRequest(req, res, u);
  }

  // ── 静态资源 ──
  if (p.startsWith('/tools/')) return serveStatic(res, p, '/tools/', TOOLS_ROOT);

  return sendJson(res, 404, {
    ok: false,
    error: 'NOT_FOUND',
    hint: '入口 /tools/index.html；API 前缀 /api/rag/*',
  });
});

// 构建索引为长耗时操作（SSE 流式进度），放宽超时（沿用旧平台口径）
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`[rag-builder] http://${HOST}:${PORT}  →  /tools/index.html`);
  console.log(`[rag-builder] KB 根目录             →  ${KB_ROOT}`);
  console.log(`[rag-builder] embeddingEnabled=${!!process.env.QWEN_KEY}（无 QWEN_KEY 时 TF-IDF 兜底）`);
});

module.exports = server;
