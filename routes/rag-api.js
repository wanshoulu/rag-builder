'use strict';

/**
 * rag-api.js — RAG 向量知识构建 API 路由层（单一入口 handleRagRequest）
 *
 * 从旧平台 routes/knowledge-studio.js 的 RAG handlers 搬运改造：
 *   - getWikiProjectPath → KB 目录解析（data/kb/<name>，KB 名正则校验防路径穿越）
 *   - 删除 usageEventLog 调用与图谱相关分支（graph-search / watch 不带）
 *   - 响应包络统一为 { ok: true, ... } / { ok: false, error }，嵌套数据结构保持源仓库形状
 *
 * 端点契约（前后端一致）：
 *   GET  /api/rag/kbs                    知识库列表 {ok, kbs:[{name, docCount, indexed, chunkCount, builtAt}]}
 *   POST /api/rag/kbs {name}             建库（mkdir docs/）{ok, kb}
 *   GET  /api/rag/documents?kb=          文档列表 {ok, docs:[{name, size, mtime}]}
 *   POST /api/rag/documents              上传：multipart(file+kb) 或 JSON {kb,name,content} → {ok, doc:{name, chars}}
 *   POST /api/rag/preview                分块预览（不落盘）{ok, chunks:[{index,text,chars}], total}
 *   POST /api/rag/build {kb,force,stream}  构建索引：stream→SSE({type:progress|done|error})，否则 {ok, taskId}
 *   GET  /api/rag/status?kb=             索引状态 {ok, indexed, chunkCount, vectorCount, digests, builtAt, embeddingEnabled}
 *   GET  /api/rag/tasks?kb=              构建任务记录 {ok, tasks:[...]}
 *   POST /api/rag/search {kb,query,mode} 混合检索 {ok, results:[{id,title,score,snippet}], embeddingEnabled}
 *   POST /api/rag/answer {kb,question}   RAG 问答 {ok, mode:GENERATED|RETRIEVAL_ONLY|NO_RESULT, answer, citations}
 *   GET  /api/rag/chunks?kb=&limit=      分块浏览 {ok, chunks:[...]}
 *   POST /api/rag/chunks/update          分块人工修订 {ok}
 *   POST /api/rag/docs/delete {kb,name}  删除文档 {ok}
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ragEnginePool = require('../tools/rag-engine-pool');
const { chunkDocument } = require('../tools/chunker');
const { parseFile } = require('../tools/multi-format-parser');
const { createRagAnswerService } = require('../tools/knowledge-rag-answer-service');

const KB_ROOT = ragEnginePool.KB_ROOT;
const KB_NAME_RE = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64}$/;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 单请求体上限 20MB（multipart 文件与 JSON 粘贴共用）
const CHUNK_LIMIT_MAX = 1000;

// RAG 问答服务（无 DEEPSEEK_KEY 时自然落入 RETRIEVAL_ONLY，无检索结果时 NO_RESULT）
const ragAnswerService = createRagAnswerService({
  defaultModel: process.env.RAG_DEFAULT_ANSWER_MODEL || 'deepseek-chat',
});

// ── 通用辅助（源自 knowledge-studio.js 的 parseBody/sendJSON 风格） ──

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(JSON.stringify(data));
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/** JSON 请求体解析，带 20MB 上限守卫 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'Request body exceeds ' + MAX_BODY_BYTES + ' bytes'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(parts).toString('utf-8').replace(/^\uFEFF/, ''); // 容忍 Windows 客户端 UTF-8 BOM
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(httpError(400, 'Invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 轻量 multipart/form-data 解析（boundary 切分，单文件 ≤20MB）。
 * 零依赖实现，只支持单文件 + 若干文本字段：返回 { fields:{name:value}, file:{field, filename, data:Buffer}|null }
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!/^multipart\/form-data/i.test(ct) || !bm) {
      reject(httpError(400, 'Expected multipart/form-data with boundary'));
      return;
    }
    const boundary = Buffer.from('--' + (bm[1] || bm[2]).trim());
    const parts = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(httpError(413, 'Upload exceeds 20MB limit'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(splitMultipart(Buffer.concat(parts), boundary));
      } catch (e) {
        reject(httpError(400, 'Multipart parse failed: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function splitMultipart(body, boundary) {
  const fields = {};
  let file = null;
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const next = body.indexOf(boundary, pos + boundary.length);
    // 段体位于本 boundary 的 CRLF 之后、下一个 boundary 前置 CRLF 之前
    const segEnd = next === -1 ? body.length : next - 2;
    const seg = body.slice(pos + boundary.length + 2, Math.max(pos + boundary.length + 2, segEnd));
    pos = next;
    if (!seg.length) continue;
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue; // 尾部 "--" 终止段等
    const headerText = seg.slice(0, headerEnd).toString('utf-8');
    const bodyBuf = seg.slice(headerEnd + 4);
    const disp = (headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i) || [])[1] || '';
    const nameM = disp.match(/name="([^"]*)"/i);
    const fileM = disp.match(/filename="([^"]*)"/i);
    if (fileM && nameM) {
      if (!file) file = { field: nameM[1], filename: fileM[1], data: bodyBuf };
    } else if (nameM) {
      fields[nameM[1]] = bodyBuf.toString('utf-8');
    }
  }
  return { fields, file };
}

// ── KB 目录解析（替代源仓库的 getWikiProjectPath；正则校验防路径穿越） ──

function validateKbName(kb) {
  const name = String(kb || '').trim();
  if (!KB_NAME_RE.test(name)) return null;
  return name;
}

function kbDir(kb) {
  return path.join(KB_ROOT, kb);
}

function readKbStats(kb) {
  // 从 .rag-cache.json 读取构建产物统计（不经引擎内部字段，避免耦合）
  const cacheFile = path.join(kbDir(kb), '.rag-cache.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (cached && cached.stats) return cached.stats;
  } catch (e) { /* 未构建或缓存损坏 */ }
  return null;
}

function kbSummary(kb) {
  const stats = readKbStats(kb);
  return {
    name: kb,
    docCount: countDocs(kb),
    indexed: !!(stats && stats.chunks > 0),
    chunkCount: (stats && stats.chunks) || 0,
    builtAt: (stats && stats.builtAt) || null,
  };
}

function docsDir(kb) {
  return path.join(kbDir(kb), 'docs');
}

function countDocs(kb) {
  try {
    return fs.readdirSync(docsDir(kb)).filter((f) => f.toLowerCase().endsWith('.md')).length;
  } catch (e) { return 0; }
}

/** 文档名净化：去掉扩展名、非法字符替换为 '-'（中文/字母/数字/下划线/连字符） */
function sanitizeDocName(raw) {
  const base = String(raw || '').replace(/\.md$/i, '').trim();
  const cleaned = base.replace(/[^\w\-\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned.length > 100 || !KB_NAME_RE.test(cleaned)) return null;
  return cleaned;
}

function readDocText(kb, name) {
  const fp = path.join(docsDir(kb), name + '.md');
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf-8');
}

/** 索引懒加载：RAGEngine 构造后不自动载入；有缓存时 buildIndex 走 digest 校验后的快速载入 */
async function ensureIndexLoaded(rag, kb) {
  if (rag.chunks && rag.chunks.length) return true;
  try { await rag.buildIndex(kb, {}); } catch (eBuild) { /* 空库/未构建：按未索引处理 */ }
  return !!(rag.chunks && rag.chunks.length);
}

// ── Handlers（搬运自 knowledge-studio.js RAG handlers，包络改为 ok 风格） ──

/** GET /api/rag/kbs */
function handleKbList(req, res) {
  let names = [];
  try {
    if (fs.existsSync(KB_ROOT)) {
      names = fs.readdirSync(KB_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    }
  } catch (e) { /* KB_ROOT 不存在则空列表 */ }
  sendJSON(res, 200, { ok: true, kbs: names.map(kbSummary) });
}

/** POST /api/rag/kbs {name} */
function handleKbCreate(req, res) {
  parseBody(req).then((body) => {
    const kb = validateKbName(body.name);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Invalid KB name（限 1-64 位中文/字母/数字/下划线/连字符）' });
    fs.mkdirSync(docsDir(kb), { recursive: true });
    sendJSON(res, 200, { ok: true, kb: kbSummary(kb) });
  }).catch((e) => sendJSON(res, e.statusCode || 500, { ok: false, error: e.message }));
}

/** GET /api/rag/documents?kb=x */
function handleDocList(req, res, u) {
  const kb = validateKbName(u.searchParams.get('kb'));
  if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
  const dir = docsDir(kb);
  const docs = [];
  try {
    fs.readdirSync(dir).forEach((f) => {
      if (!f.toLowerCase().endsWith('.md')) return;
      const st = fs.statSync(path.join(dir, f));
      docs.push({ name: f.replace(/\.md$/i, ''), size: st.size, mtime: st.mtime.toISOString() });
    });
  } catch (e) { /* docs/ 不存在 → 空列表 */ }
  docs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  sendJSON(res, 200, { ok: true, docs: docs });
}

/** POST /api/rag/documents — multipart（file + kb）或 JSON {kb, name, content} */
async function handleDocUpload(req, res) {
  try {
    const ct = req.headers['content-type'] || '';
    let kb = null;
    let name = null;
    let text = null;

    if (/^multipart\/form-data/i.test(ct)) {
      const { fields, file } = await parseMultipart(req);
      kb = validateKbName(fields.kb);
      if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb field' });
      if (!file || !file.data.length) return sendJSON(res, 400, { ok: false, error: 'Missing file part' });
      const sanitized = sanitizeDocName(path.basename(file.filename || 'upload'));
      if (!sanitized) return sendJSON(res, 400, { ok: false, error: 'Invalid file name: ' + (file.filename || '') });
      name = sanitized;
      // 落临时文件（带原始扩展名）后经 multi-format-parser 解析为文本
      const ext = path.extname(file.filename || '') || '.txt';
      const tmpPath = path.join(os.tmpdir(), 'rag-upload-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
      fs.writeFileSync(tmpPath, file.data);
      try {
        const parsed = await parseFile(tmpPath);
        text = String(parsed.text || '');
      } finally {
        try { fs.unlinkSync(tmpPath); } catch (e) { /* 清理失败不影响主流程 */ }
      }
    } else {
      const body = await parseBody(req);
      kb = validateKbName(body.kb);
      if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
      const sanitized = sanitizeDocName(body.name);
      if (!sanitized) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid name' });
      if (typeof body.content !== 'string' || !body.content.trim()) return sendJSON(res, 400, { ok: false, error: 'Missing content' });
      name = sanitized;
      text = body.content;
    }

    // 统一落盘为 docs/<name>.md
    fs.mkdirSync(docsDir(kb), { recursive: true });
    fs.writeFileSync(path.join(docsDir(kb), name + '.md'), text, 'utf-8');
    sendJSON(res, 200, { ok: true, doc: { name: name, chars: text.length } });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** POST /api/rag/preview {kb, name, strategy?, maxLen?} — 调 chunker，不落盘 */
async function handlePreview(req, res) {
  try {
    const body = await parseBody(req);
    const kb = validateKbName(body.kb);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const name = sanitizeDocName(body.name);
    if (!name) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid name' });
    const content = readDocText(kb, name);
    if (content === null) return sendJSON(res, 404, { ok: false, error: 'Document not found: ' + name });
    if (!content.trim()) return sendJSON(res, 400, { ok: false, error: 'Document is empty: ' + name });

    const chunks = chunkDocument(content, {
      strategy: body.strategy || 'auto',
      chunkSize: Number(body.maxLen) || 1024,
      overlap: 128,
    });
    sendJSON(res, 200, {
      ok: true,
      chunks: chunks.map((c, i) => ({ index: i, text: c.text, chars: c.charCount })),
      total: chunks.length,
    });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** POST /api/rag/build {kb, force?, stream?} — 内部走 pool 的 engine.buildIndex */
async function handleBuild(req, res) {
  let stream = false;
  try {
    const body = await parseBody(req);
    const kb = validateKbName(body.kb);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    stream = body.stream === true;
    const rag = ragEnginePool.getOrCreateRAGEngine(kb);

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    const sseSend = (data) => {
      try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* 连接已关闭 */ }
    };
    const taskId = 'build_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    const stats = await rag.buildIndex(kb, {
      forceRebuild: body.force === true,
      onProgress: stream
        ? (p) => { if (p.phase !== 'done') sseSend({ type: 'progress', phase: p.phase, message: p.message, current: p.current, total: p.total }); }
        : undefined,
    });

    if (stream) {
      sseSend({ type: 'done', stats: stats, timeMs: stats.timeMs });
      res.end();
    } else {
      sendJSON(res, 200, { ok: true, taskId: taskId, stats: stats });
    }
  } catch (e) {
    if (stream) {
      try {
        res.write('data: ' + JSON.stringify({ type: 'error', message: e.message }) + '\n\n');
        res.end();
      } catch (_) { /* 连接已关闭 */ }
    } else {
      sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
    }
  }
}

/** GET /api/rag/status?kb=x */
function handleStatus(req, res, u) {
  try {
    const kb = validateKbName(u.searchParams.get('kb'));
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const stats = readKbStats(kb);
    const cacheExists = fs.existsSync(path.join(kbDir(kb), '.rag-cache.json'));
    sendJSON(res, 200, {
      ok: true,
      indexed: !!(stats && stats.chunks > 0),
      chunkCount: (stats && stats.chunks) || 0,
      vectorCount: (stats && stats.embedded) || 0,
      digests: stats ? {
        source_digest: stats.source_digest || null,
        configuration_digest: stats.configuration_digest || null,
        index_digest: stats.index_digest || null,
      } : null,
      builtAt: (stats && stats.builtAt) || null,
      embeddingEnabled: !!ragEnginePool.getEmbeddingConfig(),
      stats: stats,
      cacheExists: cacheExists,
    });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** GET /api/rag/tasks?kb=x */
function handleTasks(req, res, u) {
  try {
    const kb = validateKbName(u.searchParams.get('kb'));
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const rag = ragEnginePool.getOrCreateRAGEngine(kb);
    const tasks = rag.getTaskStatus(kb);
    sendJSON(res, 200, { ok: true, tasks: tasks.tasks || [] });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** POST /api/rag/search {kb, query, mode:'keyword'|'vector'|'hybrid', topK?} */
async function handleSearch(req, res) {
  try {
    const body = await parseBody(req);
    const kb = validateKbName(body.kb);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const query = String(body.query || '').trim();
    if (!query) return sendJSON(res, 400, { ok: false, error: 'Missing query' });
    const mode = ['keyword', 'vector', 'hybrid'].indexOf(body.mode) >= 0 ? body.mode : 'hybrid';
    const topK = Math.min(100, Math.max(1, Number(body.topK) || 10));

    const rag = ragEnginePool.getOrCreateRAGEngine(kb);
    const loaded = await ensureIndexLoaded(rag, kb);
    if (!loaded) {
      return sendJSON(res, 200, { ok: true, results: [], embeddingEnabled: !!ragEnginePool.getEmbeddingConfig(), message: 'RAG 索引尚未构建，请先对该知识库执行构建（POST /api/rag/build）' });
    }

    const results = await rag.search(query, { topK: topK, mode: mode, rerank: false });
    // 剥离 _fullText 传输字段（answer 服务内部直调引擎时仍可用）
    const cleaned = (results || []).map((r) => {
      const item = Object.assign({}, r);
      delete item._fullText;
      return item;
    });
    sendJSON(res, 200, { ok: true, results: cleaned, count: cleaned.length, mode: mode, embeddingEnabled: !!ragEnginePool.getEmbeddingConfig() });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** POST /api/rag/answer {kb, question, topK?} — 调 knowledge-rag-answer-service */
async function handleAnswer(req, res) {
  try {
    const body = await parseBody(req);
    const kb = validateKbName(body.kb);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const question = String(body.question || '').trim();
    if (!question) return sendJSON(res, 400, { ok: false, error: 'Missing question' });
    const topK = Math.min(5, Math.max(1, Number(body.topK) || 5));

    const rag = ragEnginePool.getOrCreateRAGEngine(kb);
    await ensureIndexLoaded(rag, kb);

    const evidence = await ragAnswerService.answer({
      query: question,
      rag: { search: (q, opts) => rag.search(q, opts) },
      top_k: topK,
      search_mode: 'hybrid',
    });

    // 生成失败但有检索结果时按降级口径返回 RETRIEVAL_ONLY
    let mode = evidence.generation_mode;
    if (mode === 'FAILED') mode = evidence.sources.length ? 'RETRIEVAL_ONLY' : 'NO_RESULT';
    sendJSON(res, 200, {
      ok: true,
      mode: mode,
      answer: evidence.answer || '',
      citations: (evidence.sources || []).map((s) => ({ id: s.chunk_id || s.doc_id, title: s.title, snippet: s.content })),
      error: evidence.error || null,
    });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** GET /api/rag/chunks?kb=x&limit= */
async function handleChunks(req, res, u) {
  try {
    const kb = validateKbName(u.searchParams.get('kb'));
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const limit = Math.min(CHUNK_LIMIT_MAX, Math.max(1, parseInt(u.searchParams.get('limit'), 10) || 100));
    const docFilter = u.searchParams.get('docId') || '';

    const rag = ragEnginePool.getOrCreateRAGEngine(kb);
    const loaded = await ensureIndexLoaded(rag, kb);
    if (!loaded) {
      return sendJSON(res, 200, { ok: true, chunks: [], total: 0, message: 'RAG 索引尚未构建，请先对该知识库执行构建（POST /api/rag/build）' });
    }

    const filtered = docFilter ? rag.chunks.filter((c) => c.docId === docFilter) : rag.chunks;
    const paged = filtered.slice(0, limit);
    // 分块条目结构保持源仓库形状（前端兼容）
    const chunks = paged.map((c) => ({
      id: c.id,
      docId: c.docId,
      docTitle: c.docTitle,
      heading: c.heading,
      charCount: c.charCount,
      tokenEstimate: c.tokenEstimate,
      text: c.text,
      preview: c.text.slice(0, 300),
      metadata: c.metadata || {},
      edited: !!c.edited,
      editedAt: c.editedAt || null,
      vectorStale: !!c.vectorStale,
    }));
    sendJSON(res, 200, { ok: true, chunks: chunks, total: filtered.length });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** POST /api/rag/chunks/update {kb, id, text} */
async function handleChunkUpdate(req, res) {
  try {
    const body = await parseBody(req);
    const kb = validateKbName(body.kb);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const chunkId = String(body.id || '');
    const text = typeof body.text === 'string' ? body.text : '';
    if (!chunkId || !text.trim()) return sendJSON(res, 400, { ok: false, error: 'Missing id or text' });

    const rag = ragEnginePool.getOrCreateRAGEngine(kb);
    await ensureIndexLoaded(rag, kb);
    const chunk = rag.chunks.find((c) => c.id === chunkId);
    if (!chunk) return sendJSON(res, 404, { ok: false, error: 'Chunk not found: ' + chunkId });

    // 更新分块文本并重算统计（搬运自 handleRAGChunkUpdate）
    chunk.text = text;
    chunk.charCount = text.length;
    chunk.tokenEstimate = Math.ceil(text.length / 3);
    chunk.edited = true;
    chunk.editedAt = new Date().toISOString();

    // 同步关键词索引
    if (rag.keywordEngine) {
      const doc = rag.keywordEngine.documents.find((d) => d.id === chunkId);
      if (doc) {
        doc.content = text;
        doc.tokens = rag.keywordEngine.tokenize(text);
      }
    }

    // 重嵌入修订分块（尽力而为 — 失败标记 vectorStale）
    let vectorState = { reembedded: false, stale: true };
    try {
      const re = await rag.reembedChunk(chunkId);
      vectorState = { reembedded: !!re.ok, stale: !re.ok };
      if (re.error) vectorState.error = re.error;
    } catch (reErr) {
      vectorState.error = reErr.message;
    }

    // 持久化缓存（KB 目录口径，替代源仓库的 wikiDir 拼接）
    const cacheFile = path.join(kbDir(kb), '.rag-cache.json');
    if (typeof rag._saveCache === 'function') rag._saveCache(cacheFile);

    sendJSON(res, 200, {
      ok: true,
      chunk: { id: chunk.id, charCount: chunk.charCount, tokenEstimate: chunk.tokenEstimate, vectorStale: !!chunk.vectorStale },
      vector: vectorState,
    });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

/** POST /api/rag/docs/delete {kb, name} */
async function handleDocDelete(req, res) {
  try {
    const body = await parseBody(req);
    const kb = validateKbName(body.kb);
    if (!kb) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid kb' });
    const name = sanitizeDocName(body.name);
    if (!name) return sendJSON(res, 400, { ok: false, error: 'Missing or invalid name' });

    const fp = path.join(docsDir(kb), name + '.md');
    if (!fs.existsSync(fp)) return sendJSON(res, 404, { ok: false, error: 'Document not found: ' + name });
    fs.unlinkSync(fp);

    // 同步清理索引缓存中该文档的分块（搬运自 handleRAGDocDelete）
    // 引擎扫描 KB 目录时 docId 为相对路径（docs/<name>.md）
    let result = { removed: 0, remainingChunks: 0 };
    try {
      const rag = ragEnginePool.getOrCreateRAGEngine(kb);
      if (typeof rag.removeDocument === 'function') result = rag.removeDocument(kb, 'docs/' + name + '.md') || result;
    } catch (e) { /* 索引清理失败不阻塞文档删除 */ }

    sendJSON(res, 200, { ok: true, result: result });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

// ── 路由分发表（对应源仓库 L405-L416 的挂载方式，前缀 /api/rag/*） ──

const ROUTES = {
  'GET /api/rag/kbs': handleKbList,
  'POST /api/rag/kbs': handleKbCreate,
  'GET /api/rag/documents': handleDocList,
  'POST /api/rag/documents': handleDocUpload,
  'POST /api/rag/preview': handlePreview,
  'POST /api/rag/build': handleBuild,
  'GET /api/rag/status': handleStatus,
  'GET /api/rag/tasks': handleTasks,
  'POST /api/rag/search': handleSearch,
  'POST /api/rag/answer': handleAnswer,
  'GET /api/rag/chunks': handleChunks,
  'POST /api/rag/chunks/update': handleChunkUpdate,
  'POST /api/rag/docs/delete': handleDocDelete,
};

/** 单一入口：按 method+pathname 分发；未匹配路径返回 404（含允许清单提示） */
function handleRagRequest(req, res, u) {
  const method = (req.method || 'GET').toUpperCase();
  const pathname = req.pathname || u.pathname;
  const handler = ROUTES[method + ' ' + pathname];
  if (handler) {
    handler(req, res, u);
    return;
  }
  if (ROUTES['GET ' + pathname] || ROUTES['POST ' + pathname]) {
    sendJSON(res, 405, { ok: false, error: 'Method not allowed: ' + method + ' ' + pathname });
    return;
  }
  sendJSON(res, 404, { ok: false, error: 'NOT_FOUND', path: pathname, hint: '可用端点：' + Object.keys(ROUTES).join(', ') });
}

module.exports = { handleRagRequest };
