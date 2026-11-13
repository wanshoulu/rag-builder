/**
 * rag-builder — RAG 向量检索引擎（分块 → 嵌入 → 向量索引 → 混合检索）
 *
 * 流程:
 *   1. 扫描知识库文档（.md / .txt，跳过 log.md 与 . 开头文件）
 *   2. 分块（可配置策略 + 大小 + 重叠）
 *   3. 嵌入 chunks（Qwen text-embedding-v4，经 tools/embedding.js 共享磁盘缓存；
 *      无 key 或调用失败时回退本地 TF-IDF/BM25 关键词单路）
 *   4. 索引缓存落盘（.rag-cache.json，v6 格式：source_digest / configuration_digest /
 *      index_digest 三段 sha256 校验，任何源文档、构建配置或索引内容变更都会触发重建）
 *   5. 混合检索：BM25 关键词 + 向量余弦 → RRF 融合（k=60，可选 LLM rerank）
 *
 * Usage:
 *   const { RAGEngine } = require('./tools/rag-engine');
 *   const rag = new RAGEngine({ kbRoot, embeddingConfig });
 *   await rag.buildIndex(projectName);
 *   const results = await rag.search('query', { topK: 10 });
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { chunkDocuments } = require('./chunker');
const { BM25Engine } = require('./bm25-engine');
const embeddingStore = require('./embedding');

class RAGEngine {
  constructor(options) {
    this.options = options || {};
    this.kbRoot = this.options.kbRoot || path.join(__dirname, '..', 'data', 'kb');
    this.embeddingConfig = this.options.embeddingConfig || null;

    // Runtime state
    this.chunks = [];       // [{id, docId, docTitle, text, charCount, tokenEstimate, heading?}]
    this.vectors = [];      // [{chunkId, vector: [...], norm}]
    this.keywordEngine = null;
    this.stats = null;
  }

  /**
   * Build RAG index for a KB project
   * @param {string} projectName - kb project name (subdir of kbRoot)
   * @param {object} opts - { chunkSize, overlap, strategy, forceRebuild, filterDocs, onProgress }
   * @returns {object} stats { documents, chunks, embedded, dim, timeMs }
   */
  async buildIndex(projectName, opts) {
    var self = this;
    var options = opts || {};
    var chunkSize = options.chunkSize || 1024;
    var overlap = options.overlap || 128;
    var strategy = options.strategy || 'markdown';
    var forceRebuild = options.forceRebuild || false;
    var onProgress = options.onProgress || function() {};
    var filterDocs = Array.isArray(options.filterDocs)
      ? Array.from(new Set(options.filterDocs.map(function(id) { return String(id).replace(/\\/g, '/'); }))).sort()
      : null;

    var startTime = Date.now();
    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    if (!fs.existsSync(wp)) throw new Error('KB project not found: ' + projectName);

    var cacheFile = path.join(wp, '.rag-cache.json');
    // Observe source and index-affecting configuration before considering cache reuse.
    var docs = this._scanWiki(wp);
    if (filterDocs) {
      var filterSet = new Set(filterDocs);
      docs = docs.filter(function(doc) { return filterSet.has(String(doc.id).replace(/\\/g, '/')); });
    }
    if (!docs.length) throw new Error('No documents found in project: ' + projectName);
    var sourceDigest = this._sourceDigest(docs);
    var configurationDigest = this._configurationDigest({
      chunkSize: chunkSize,
      overlap: overlap,
      strategy: strategy,
      filterDocs: filterDocs,
    });

    // Check cache
    if (!forceRebuild && fs.existsSync(cacheFile)) {
      try {
        var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        var cachedVectors = this._hydrateCachedVectors(cached.vectors || []);
        var verifiedIndexDigest = this._indexDigest(cached.chunks || [], cachedVectors, sourceDigest, configurationDigest);
        if (cached.version === 6 && this._validCachePayload(cached) && cached.source_digest === sourceDigest
          && cached.configuration_digest === configurationDigest
          && cached.index_digest === verifiedIndexDigest && cached.chunks && cached.chunks.length) {
          this.chunks = cached.chunks;
          this.vectors = cachedVectors;
          this.stats = this._derivedStats(projectName, this.chunks, this.vectors,
            { chunkSize: chunkSize, overlap: overlap, strategy: strategy },
            { source_digest: sourceDigest, configuration_digest: configurationDigest, index_digest: verifiedIndexDigest },
            cached.stats);
          this._buildKeywordIndex();
          onProgress({ phase: 'done', message: '从缓存加载', stats: this.stats });
          return this.stats;
        }
      } catch(e) { /* cache corrupted, rebuild */ }
    }

    // Step 1: Scan KB documents
    onProgress({ phase: 'scan', message: '扫描文档...', current: 0, total: 0 });
    onProgress({ phase: 'scan_done', message: '扫描完成: ' + docs.length + ' 文档', total: docs.length });

    // Step 2: Chunk documents
    onProgress({ phase: 'chunk', message: '分块处理...', current: 0, total: docs.length });
    var chunks = chunkDocuments(docs, { strategy: strategy, chunkSize: chunkSize, overlap: overlap });
    var parentCounters = new Map();
    var parentIds = new Map();
    chunks.forEach(function(chunk) {
      if (chunk.isParent !== true) return;
      var next = parentCounters.get(chunk.docId) || 0;
      parentCounters.set(chunk.docId, next + 1);
      parentIds.set(chunk.docId + '\u0000parent_' + next, chunk.id);
    });
    chunks.forEach(function(chunk) {
      if (chunk.isChild === true && typeof chunk.parentId === 'string') {
        chunk.parentId = parentIds.get(chunk.docId + '\u0000' + chunk.parentId) || chunk.parentId;
      }
    });
    this.chunks = chunks;
    onProgress({ phase: 'chunk_done', message: '分块完成: ' + chunks.length + ' chunks', total: chunks.length });

    // Step 3: Build keyword index for hybrid search
    onProgress({ phase: 'keyword', message: '构建关键词索引...' });
    this.keywordEngine = new BM25Engine();
    this._buildKeywordIndex();

    // Step 4: Embed chunks (if embedding config available)
    var embedded = 0;
    var dim = 0;
    if (this.embeddingConfig && this.embeddingConfig.apiKey) {
      onProgress({ phase: 'embed', message: '向量化...', current: 0, total: chunks.length });
      var vectors = await this._embedChunks(chunks, onProgress);
      this.vectors = vectors;
      embedded = vectors.filter(function(v) { return v.vector && v.vector.length > 0; }).length;
      dim = vectors.length > 0 ? (vectors[0].vector ? vectors[0].vector.length : 0) : 0;
      onProgress({ phase: 'embed_done', message: '向量化完成: ' + embedded + '/' + chunks.length, embedded: embedded, total: chunks.length });
    } else {
      // No embedding — keyword-only mode
      this.vectors = [];
      onProgress({ phase: 'embed_skip', message: '无API Key，跳过向量化' });
    }

    // Step 5: Save cache
    var timeMs = Date.now() - startTime;
    var indexDigest = this._indexDigest(chunks, this.vectors, sourceDigest, configurationDigest);
    this.stats = {
      project: projectName || '(root)',
      documents: docs.length,
      chunks: chunks.length,
      embedded: embedded,
      dim: dim,
      chunkSize: chunkSize,
      overlap: overlap,
      strategy: strategy,
      timeMs: timeMs,
      builtAt: new Date().toISOString(),
      source_digest: sourceDigest,
      configuration_digest: configurationDigest,
      index_digest: indexDigest,
    };
    this._saveCache(cacheFile);

    // Persist per-file hashes so incrementalUpdate can diff properly on its
    // first run (without this, every doc looks "added" and chunks get duplicated)
    try {
      var manifest = {};
      docs.forEach(function(doc) { manifest[doc.id] = self._hashContent(doc.content); });
      fs.writeFileSync(path.join(wp, '.rag-manifest.json'), JSON.stringify(manifest), 'utf-8');
    } catch(e) { /* manifest is an optimization; cache digest still guards correctness */ }

    // Save task record
    this._saveTaskStatus(projectName, {
      type: forceRebuild ? 'full' : 'build',
      documents: docs.length,
      chunks: chunks.length,
      embedded: embedded,
      timeMs: timeMs,
      status: 'completed',
      at: new Date().toISOString(),
    });

    onProgress({ phase: 'done', message: '构建完成', stats: this.stats, timeMs: timeMs });
    return this.stats;
  }

  /**
   * Hybrid search: embedding cosine + BM25 keyword → RRF fusion
   */
  async search(query, options) {
    var opts = options || {};
    var topK = opts.topK || 10;
    var mode = opts.mode || 'hybrid'; // keyword | vector | hybrid
    var rerank = opts.rerank || false; // LLM reranking

    // Keyword search
    var keywordResults = [];
    if (mode === 'keyword' || mode === 'hybrid') {
      if (!this.keywordEngine) this._buildKeywordIndex();
      keywordResults = this.keywordEngine.search(query, { topK: topK * 2 });
    }

    // Vector search
    var vectorResults = [];
    if ((mode === 'vector' || mode === 'hybrid') && this.vectors.length && this.embeddingConfig) {
      vectorResults = await this._vectorSearch(query, topK * 2);
    }

    // RRF fusion
    var finalResults;
    if (mode === 'hybrid' && vectorResults.length > 0) {
      var k = 60;
      var kwRank = {}, vecRank = {};
      keywordResults.forEach(function(r, i) { kwRank[r.id || r.title] = i + 1; });
      vectorResults.forEach(function(r, i) { vecRank[r.id || r.title] = i + 1; });
      var allIds = {};
      Object.keys(kwRank).forEach(function(id) { allIds[id] = true; });
      Object.keys(vecRank).forEach(function(id) { allIds[id] = true; });

      finalResults = Object.keys(allIds).map(function(id) {
        var kwR = kwRank[id] || 999;
        var vecR = vecRank[id] || 999;
        return { id: id, title: (vectorResults.find(function(v){return v.id===id})||{}).title || (keywordResults.find(function(kw){return kw.id===id})||{}).title || id, score: 1/(k+kwR)*0.6 + 1/(k+vecR)*0.4 };
      });
      finalResults.sort(function(a, b) { return b.score - a.score; });
      finalResults = finalResults.slice(0, topK * (rerank ? 3 : 1)); // Fetch more candidates if reranking
    } else if (mode === 'vector') {
      finalResults = vectorResults.slice(0, topK * (rerank ? 3 : 1));
    } else {
      finalResults = keywordResults.slice(0, topK * (rerank ? 3 : 1));
    }

    // Enrich results with chunk text
    var self = this;
    var enriched = finalResults.map(function(r) {
      var chunk = self.chunks.find(function(c) { return c.id === r.id || c.docId === r.id; });
      return {
        id: r.id,
        title: r.title || (chunk ? chunk.docTitle : ''),
        score: r.score || 0,
        snippet: chunk ? chunk.text.slice(0, 300) : '',
        docId: chunk ? chunk.docId : r.id,
        heading: chunk ? chunk.heading : undefined,
        metadata: chunk ? (chunk.metadata || {}) : {},
        _fullText: chunk ? chunk.text : '',
      };
    });

    // LLM reranking: score each result's relevance to the query
    if (rerank && enriched.length > 1 && this.embeddingConfig && this.embeddingConfig.apiKey) {
      try {
        enriched = await this._llmRerank(query, enriched, topK);
      } catch(e) {
        console.error('[RAGEngine] Rerank failed, using original order:', e.message);
      }
    }

    return enriched.slice(0, topK);
  }

  /**
   * LLM Reranking: ask LLM to score each candidate's relevance to the query
   */
  async _llmRerank(query, candidates, topK) {
    var llmConfig = this._getLLMConfig();
    if (!llmConfig) return candidates.slice(0, topK);

    // Build prompt for LLM scoring
    var candidatesText = candidates.map(function(c, i) {
      return '[Doc ' + (i + 1) + '] ' + (c.heading || c.title) + '\n' + c._fullText.slice(0, 500);
    }).join('\n\n---\n\n');

    var systemPrompt = '你是一个文档相关性评分专家。用户提出了一个查询，请为每个候选文档打分（0-10分），评分标准：\n' +
      '10分：完全匹配查询意图，包含直接答案\n' +
      '7分：高度相关，包含查询相关的关键信息\n' +
      '4分：部分相关，有少量关联信息\n' +
      '1分：不相关\n' +
      '只返回JSON数组格式：[{"index":1,"score":9.5},{"index":2,"score":7.0}]，不要其他文字。';

    var userPrompt = '查询：' + query + '\n\n候选文档：\n' + candidatesText;

    var body = JSON.stringify({
      model: llmConfig.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    });

    return new Promise(function(resolve, reject) {
      var https = require('https');
      var req = https.request({
        hostname: llmConfig.host,
        port: 443,
        path: llmConfig.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + llmConfig.apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
      }, function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(data);
            var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
            if (!content) { resolve(candidates.slice(0, topK)); return; }

            // Parse scores from LLM response
            var scores = [];
            var match = content.match(/\[[\s\S]*\]/);
            if (match) {
              scores = JSON.parse(match[0]);
            }

            // Apply scores to candidates
            candidates.forEach(function(c, i) {
              var scoreEntry = scores.find(function(s) { return s.index === i + 1; });
              if (scoreEntry) {
                c.rerankScore = scoreEntry.score;
                c.originalScore = c.score;
                c.score = (scoreEntry.score / 10) * 0.7 + c.score * 0.3; // Weighted blend
              }
            });

            // Sort by new score
            candidates.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
            resolve(candidates);
          } catch(e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('LLM rerank timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * LLM rerank 服务配置：读环境变量 DEEPSEEK_KEY，无 key 返回 null（_llmRerank 已有降级保护）
   */
  _getLLMConfig() {
    var apiKey = process.env.DEEPSEEK_KEY;
    if (!apiKey) return null;
    return {
      host: 'api.deepseek.com',
      path: '/chat/completions',
      model: process.env.RAG_RERANK_MODEL || 'deepseek-chat',
      apiKey: apiKey,
    };
  }

  /**
   * Get index status
   */
  getStatus() {
    return this.stats || { project: '(not built)', documents: 0, chunks: 0, embedded: 0 };
  }

  /**
   * Preview chunks for a document without building the index
   */
  previewDocumentChunks(content, options) {
    var { previewChunks } = require('./chunker');
    return previewChunks(content, options);
  }

  /**
   * Remove all chunks belonging to a specific document
   */
  removeDocument(projectName, docId) {
    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    var cacheFile = path.join(wp, '.rag-cache.json');

    if (fs.existsSync(cacheFile)) {
      try {
        var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        var before = (cached.chunks || []).length;
        cached.chunks = (cached.chunks || []).filter(function(c) { return c.docId !== docId; });
        var removedCount = before - cached.chunks.length;

        var removedIds = {};
        (cached.vectors || []).forEach(function(v, i) {
          if (cached.chunks.every(function(c) { return c.id !== v.chunkId; })) {
            removedIds[v.chunkId] = true;
          }
        });
        cached.vectors = (cached.vectors || []).filter(function(v) { return !removedIds[v.chunkId]; });

        if (cached.stats) {
          cached.stats.documents = Math.max(0, (cached.stats.documents || 0) - 1);
          cached.stats.chunks = cached.chunks.length;
          cached.stats.embedded = cached.vectors.filter(function(v) { return v.vector && v.vector.length > 0; }).length;
          cached.stats.builtAt = new Date().toISOString();
        }
        fs.writeFileSync(cacheFile, JSON.stringify(cached), 'utf-8');

        // Also update manifest
        var manifestFile = path.join(wp, '.rag-manifest.json');
        if (fs.existsSync(manifestFile)) {
          try {
            var manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
            delete manifest[docId];
            fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf-8');
          } catch(e) {}
        }

        return { removed: removedCount, remainingChunks: cached.chunks.length };
      } catch(e) { return { error: e.message }; }
    }
    return { removed: 0, remainingChunks: 0 };
  }

  /**
   * Index task tracking
   */
  getTaskStatus(projectName) {
    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    var taskFile = path.join(wp, '.rag-tasks.json');
    if (!fs.existsSync(taskFile)) return { tasks: [] };
    try { return JSON.parse(fs.readFileSync(taskFile, 'utf-8')); } catch(e) { return { tasks: [] }; }
  }

  _saveTaskStatus(projectName, task) {
    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    var taskFile = path.join(wp, '.rag-tasks.json');
    var data = this.getTaskStatus(projectName);
    data.tasks.unshift(task);
    if (data.tasks.length > 100) data.tasks.length = 100; // keep last 100
    try { fs.writeFileSync(taskFile, JSON.stringify(data, null, 2), 'utf-8'); } catch(e) {}
  }

  /**
   * Incremental update — only re-process changed/new/deleted files
   * @returns { added, updated, removed, total }
   */
  async incrementalUpdate(projectName, opts) {
    var self = this;
    var options = opts || {};
    var chunkSize = options.chunkSize || (this.stats ? this.stats.chunkSize : 1024);
    var overlap = options.overlap || (this.stats ? this.stats.overlap : 128);
    var strategy = options.strategy || (this.stats ? this.stats.strategy : 'markdown');

    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    var cacheFile = path.join(wp, '.rag-cache.json');
    var currentDocs = this._scanWiki(wp);
    var sourceDigest = this._sourceDigest(currentDocs);
    var configurationDigest = this._configurationDigest({ chunkSize: chunkSize, overlap: overlap, strategy: strategy });

    // Load existing cache
    if (!this.chunks.length && fs.existsSync(cacheFile)) {
      try {
        var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        var hydrated = this._hydrateCachedVectors(cached.vectors || []);
        var verified = this._indexDigest(cached.chunks || [], hydrated, sourceDigest, configurationDigest);
        if (cached.version !== 6 || cached.source_digest !== sourceDigest
          || cached.configuration_digest !== configurationDigest || cached.index_digest !== verified) {
          return await this.buildIndex(projectName, Object.assign({}, options, { forceRebuild: true }));
        }
        this.chunks = cached.chunks || [];
        this.vectors = hydrated;
        this.stats = this._derivedStats(projectName, this.chunks, this.vectors,
          { chunkSize: chunkSize, overlap: overlap, strategy: strategy },
          { source_digest: sourceDigest, configuration_digest: configurationDigest, index_digest: verified },
          cached.stats);
      } catch(e) { /* will do full rebuild */ }
    }

    // If no existing index, do full build
    if (!this.chunks.length) {
      return await this.buildIndex(projectName, options);
    }

    if (this.stats && (this.stats.source_digest !== sourceDigest || this.stats.configuration_digest !== configurationDigest)) {
      return await this.buildIndex(projectName, Object.assign({}, options, { forceRebuild: true }));
    }

    var currentMap = {};
    currentDocs.forEach(function(d) { currentMap[d.id] = d; });

    var existingMap = {};
    this.chunks.forEach(function(c) { existingMap[c.docId] = true; });

    // Compute file hashes
    var currentHashes = {};
    currentDocs.forEach(function(d) {
      currentHashes[d.id] = self._hashContent(d.content);
    });

    var existingHashes = {};
    var manifestFile = path.join(wp, '.rag-manifest.json');
    if (fs.existsSync(manifestFile)) {
      try { existingHashes = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')); } catch(e) {}
    }

    // Find changes
    var changed = [];
    var added = [];
    var removedIds = [];

    Object.keys(currentHashes).forEach(function(docId) {
      if (!existingHashes[docId]) { added.push(docId); }
      else if (existingHashes[docId] !== currentHashes[docId]) { changed.push(docId); }
    });
    Object.keys(existingHashes).forEach(function(docId) {
      if (!currentHashes[docId]) removedIds.push(docId);
    });

    var totalChanges = added.length + changed.length + removedIds.length;

    if (totalChanges === 0) {
      return { added: 0, updated: 0, removed: 0, total: this.chunks.length, message: 'No changes detected' };
    }

    // Remove chunks for deleted/changed docs
    var removedChunkIds = [];
    this.chunks = this.chunks.filter(function(c) {
      if (removedIds.indexOf(c.docId) >= 0 || changed.indexOf(c.docId) >= 0) {
        removedChunkIds.push(c.id);
        return false;
      }
      return true;
    });
    this.vectors = this.vectors.filter(function(v) { return removedChunkIds.indexOf(v.chunkId) < 0; });

    // Process added + changed docs
    var toProcess = [];
    added.forEach(function(id) { if (currentMap[id]) toProcess.push(currentMap[id]); });
    changed.forEach(function(id) { if (currentMap[id]) toProcess.push(currentMap[id]); });

    if (toProcess.length > 0) {
      var { chunkDocuments } = require('./chunker');
      var newChunks = chunkDocuments(toProcess, { strategy: strategy, chunkSize: chunkSize, overlap: overlap });

      // Embed new chunks if embedding is available
      if (this.embeddingConfig && this.embeddingConfig.apiKey) {
        var batchSize = this.embeddingConfig.batchSize || 10;
        for (var i = 0; i < newChunks.length; i += batchSize) {
          var batch = newChunks.slice(i, i + batchSize);
          try {
            var embs = await this._callEmbedding(batch.map(function(c) { return c.text.slice(0, 2000); }), this.embeddingConfig);
            for (var j = 0; j < embs.length; j++) {
              var n = norm(embs[j]);
              this.vectors.push({ chunkId: batch[j].id, vector: embs[j], norm: n || 1 });
            }
          } catch(e) { /* skip failed batch */ }
        }
      }

      this.chunks = this.chunks.concat(newChunks);
    }

    // Rebuild keyword index
    this._buildKeywordIndex();

    // Update stats
    var indexDigest = this._indexDigest(this.chunks, this.vectors, sourceDigest, configurationDigest);
    this.stats = {
      project: projectName || '(root)',
      documents: currentDocs.length,
      chunks: this.chunks.length,
      embedded: this.vectors.filter(function(v) { return v.vector && v.vector.length > 0; }).length,
      dim: this.vectors.length > 0 && this.vectors[0].vector ? this.vectors[0].vector.length : 0,
      chunkSize: chunkSize, overlap: overlap, strategy: strategy,
      timeMs: 0,
      builtAt: new Date().toISOString(),
      source_digest: sourceDigest,
      configuration_digest: configurationDigest,
      index_digest: indexDigest,
    };

    // Save
    this._saveCache(cacheFile);
    fs.writeFileSync(manifestFile, JSON.stringify(currentHashes), 'utf-8');

    return { added: added.length, updated: changed.length, removed: removedIds.length, total: this.chunks.length };
  }

  /**
   * Watch a KB project and auto-update on file changes
   */
  watch(projectName) {
    var self = this;
    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    if (!fs.existsSync(wp)) return null;

    var watcher = fs.watch(wp, { recursive: true }, function(eventType, filename) {
      if (!filename || !/\.(md|txt)$/.test(filename)) return;
      // Debounce: wait 5s before updating
      if (self._watchTimeout) clearTimeout(self._watchTimeout);
      self._watchTimeout = setTimeout(function() {
        console.log('[RAGEngine] File changed:', filename, '— incremental update');
        self.incrementalUpdate(projectName).then(function(result) {
          console.log('[RAGEngine] Updated:', result.added, 'added,', result.updated, 'updated,', result.removed, 'removed,', result.total, 'total chunks');
        }).catch(function(e) {
          console.error('[RAGEngine] Update failed:', e.message);
        });
      }, 5000);
    });

    return watcher;
  }

  _hashContent(content) {
    return crypto.createHash('sha256').update(content || '').digest('hex').slice(0, 16);
  }

  _canonicalDigest(value) {
    function normalize(input) {
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === 'object') {
        return Object.keys(input).sort().reduce(function(result, key) {
          if (input[key] !== undefined) result[key] = normalize(input[key]);
          return result;
        }, {});
      }
      return input;
    }
    return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
  }

  _sourceDigest(docs) {
    return this._canonicalDigest((docs || []).map(function(doc) {
      return { id: String(doc.id || ''), title: String(doc.title || ''), content: String(doc.content || '') };
    }).sort(function(left, right) { return left.id.localeCompare(right.id); }));
  }

  _configurationDigest(options) {
    var config = this.embeddingConfig || {};
    var source = options || {};
    return this._canonicalDigest({
      chunk_size: Number(source.chunkSize || 1024), overlap: Number(source.overlap || 128),
      strategy: String(source.strategy || 'markdown'),
      filter_docs: Array.isArray(source.filterDocs) ? source.filterDocs.slice().sort() : [],
      embedding: {
        provider: String(config.provider || config.host || 'NONE'), host: String(config.host || ''),
        path: String(config.path || ''), model: String(config.model || ''),
        dimension: Number(config.dimension || config.dim || 0), batch_size: Number(config.batchSize || 10),
      },
    });
  }

  _indexDigest(chunks, vectors, sourceDigest, configurationDigest) {
    var self = this;
    return this._canonicalDigest({
      source_digest: sourceDigest,
      configuration_digest: configurationDigest,
      chunks: (chunks || []).map(function(chunk) { return self._cacheChunk(chunk); }),
      vectors: (vectors || []).map(function(vector) { return self._cacheVector(vector); }),
    });
  }

  _cacheChunk(chunk) {
    var source = chunk || {};
    return {
      id: source.id,
      docId: source.docId,
      docTitle: source.docTitle,
      text: source.text,
      charCount: source.charCount,
      tokenEstimate: source.tokenEstimate,
      heading: source.heading,
      isParent: source.isParent,
      isChild: source.isChild,
      parentId: source.parentId,
      metadata: source.metadata || {},
      edited: !!source.edited,
      editedAt: source.editedAt || null,
      vectorStale: !!source.vectorStale,
    };
  }

  _cacheVector(vector) {
    var source = vector || {};
    return { chunkId: source.chunkId, vector: source.vector || [], norm: source.norm };
  }

  _derivedStats(projectName, chunks, vectors, options, identities, cachedMetadata) {
    var safeChunks = chunks || [];
    var safeVectors = vectors || [];
    var config = options || {};
    var metadata = cachedMetadata || {};
    var populatedVectors = safeVectors.filter(function(item) { return Array.isArray(item.vector) && item.vector.length > 0; });
    var dimension = populatedVectors.length ? populatedVectors[0].vector.length : 0;
    var docIds = new Set(safeChunks.map(function(chunk) { return String(chunk.docId || ''); }).filter(Boolean));
    return {
      project: projectName || '(root)',
      documents: docIds.size,
      chunks: safeChunks.length,
      embedded: populatedVectors.length,
      dim: dimension,
      chunkSize: Number(config.chunkSize || 1024),
      overlap: Number(config.overlap || 128),
      strategy: String(config.strategy || 'markdown'),
      timeMs: typeof metadata.timeMs === 'number' && Number.isFinite(metadata.timeMs) && metadata.timeMs >= 0 ? metadata.timeMs : 0,
      builtAt: typeof metadata.builtAt === 'string' ? metadata.builtAt : null,
      source_digest: identities.source_digest,
      configuration_digest: identities.configuration_digest,
      index_digest: identities.index_digest,
    };
  }

  _validCachePayload(cached) {
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)
      || !Array.isArray(cached.chunks) || !cached.chunks.length || !Array.isArray(cached.vectors)) return false;
    if (![cached.source_digest, cached.configuration_digest, cached.index_digest]
      .every(function(value) { return /^sha256:[a-f0-9]{64}$/i.test(String(value || '')); })) return false;
    var chunkIds = new Set();
    var parents = new Set();
    for (var i = 0; i < cached.chunks.length; i++) {
      var chunk = cached.chunks[i];
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)
        || typeof chunk.id !== 'string' || !chunk.id || chunkIds.has(chunk.id)
        || typeof chunk.docId !== 'string' || !chunk.docId
        || typeof chunk.docTitle !== 'string'
        || typeof chunk.text !== 'string' || !chunk.text.trim()
        || !Number.isFinite(chunk.charCount) || chunk.charCount < 0
        || !Number.isFinite(chunk.tokenEstimate) || chunk.tokenEstimate < 0
        || chunk.metadata === null || typeof chunk.metadata !== 'object' || Array.isArray(chunk.metadata)
        || chunk.isParent !== undefined && typeof chunk.isParent !== 'boolean'
        || chunk.isChild !== undefined && typeof chunk.isChild !== 'boolean'
        || chunk.isParent === true && chunk.isChild === true) return false;
      chunkIds.add(chunk.id);
      if (chunk.isParent === true) parents.add(chunk.id);
    }
    for (var j = 0; j < cached.chunks.length; j++) {
      var child = cached.chunks[j];
      if (child.isChild === true && (typeof child.parentId !== 'string' || !parents.has(child.parentId))) return false;
    }
    var vectorIds = new Set();
    var dimension = null;
    for (var k = 0; k < cached.vectors.length; k++) {
      var vector = cached.vectors[k];
      if (!vector || typeof vector !== 'object' || Array.isArray(vector)
        || typeof vector.chunkId !== 'string' || !chunkIds.has(vector.chunkId) || vectorIds.has(vector.chunkId)
        || !Array.isArray(vector.vector) || vector.vector.some(function(value) { return !Number.isFinite(value); })
        || !Number.isFinite(vector.norm) || vector.norm < 0) return false;
      if (vector.vector.length) {
        if (dimension === null) dimension = vector.vector.length;
        else if (dimension !== vector.vector.length) return false;
      }
      vectorIds.add(vector.chunkId);
    }
    return true;
  }

  /**
   * Read-only verification of the exact persisted cache for a project.
   * The result intentionally contains identities and derived counts only.
   */
  verifyCache(projectName, certification) {
    var wp = projectName ? path.join(this.kbRoot, projectName) : this.kbRoot;
    var cacheFile = path.join(wp, '.rag-cache.json');
    var publicBase = { cache_file: '.rag-cache.json' };
    var cacheExists = false;
    try { cacheExists = fs.existsSync(cacheFile) && fs.statSync(cacheFile).isFile(); } catch (_) {}
    if (!cacheExists) {
      return Object.assign({ valid: false, code: 'CACHE_NOT_FOUND' }, publicBase);
    }
    var cached;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
    catch (_) { return Object.assign({ valid: false, code: 'CACHE_PAYLOAD_INVALID' }, publicBase); }
    if (cached.version !== 6) return Object.assign({ valid: false, code: 'CACHE_SCHEMA_INVALID' }, publicBase);
    if (!this._validCachePayload(cached)) return Object.assign({ valid: false, code: 'CACHE_PAYLOAD_INVALID' }, publicBase);
    var docs = this._scanWiki(wp);
    var sourceDigest = this._sourceDigest(docs);
    if (cached.source_digest !== sourceDigest) {
      return Object.assign({ valid: false, code: 'CACHE_SOURCE_MISMATCH' }, publicBase);
    }
    var hydratedVectors = this._hydrateCachedVectors(cached.vectors);
    var indexDigest = this._indexDigest(cached.chunks, hydratedVectors, sourceDigest, cached.configuration_digest);
    if (cached.index_digest !== indexDigest) {
      return Object.assign({ valid: false, code: 'CACHE_PAYLOAD_INVALID' }, publicBase);
    }
    var expected = certification || {};
    var actualCertification = {
      source_digest: sourceDigest,
      configuration_digest: cached.configuration_digest,
      index_digest: indexDigest,
    };
    if (JSON.stringify(actualCertification) !== JSON.stringify({
      source_digest: expected.source_digest,
      configuration_digest: expected.configuration_digest,
      index_digest: expected.index_digest,
    })) {
      return Object.assign({ valid: false, code: 'CACHE_CERTIFICATION_MISMATCH' }, publicBase);
    }
    var stats = this._derivedStats(projectName, cached.chunks, hydratedVectors, {}, actualCertification, {});
    return Object.assign({
      valid: true,
      certification: actualCertification,
      stats: { documents: stats.documents, chunks: stats.chunks, embedded: stats.embedded, dim: stats.dim },
    }, publicBase);
  }

  // ── Internal ──

  _scanWiki(wp) {
    var docs = [];
    var self = this;
    function scan(dir, relRoot) {
      relRoot = relRoot || '';
      var entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
      entries.forEach(function(entry) {
        var fp = path.join(dir, entry.name);
        var rp = relRoot ? relRoot + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'syntheses') return;
          scan(fp, rp);
        } else if (entry.isFile() && /\.(md|txt)$/.test(entry.name)
          && !entry.name.startsWith('.') && entry.name.toLowerCase() !== 'log.md') {
          try {
            var content = fs.readFileSync(fp, 'utf-8');
            var isMarkdown = /\.md$/.test(entry.name);
            var text = isMarkdown ? content.replace(/^---[\s\S]*?---\n*/, '').trim() : String(content || '').trim();
            if (text.length > 50) {
              var title = (isMarkdown ? self._extractTitle(content) : self._extractTxtTitle(text))
                || entry.name.replace(/\.(md|txt)$/, '');
              docs.push({ id: rp, title: title, content: text });
            }
          } catch(e) { /* skip */ }
        }
      });
    }
    scan(wp);
    return docs;
  }

  _extractTitle(content) {
    var match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * .txt 标题提取：取第一个非空行，截断到 100 字符；无非空行时由调用方兜底文件名
   */
  _extractTxtTitle(text) {
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line) return line.slice(0, 100);
    }
    return null;
  }

  _buildKeywordIndex() {
    this.keywordEngine = new BM25Engine();
    // Build a lightweight index from chunk texts
    this.keywordEngine.index = new Map();
    this.keywordEngine.documents = [];

    var self = this;
    this.chunks.forEach(function(chunk) {
      var tokens = self.keywordEngine.tokenize(chunk.text);
      tokens.forEach(function(token) {
        if (!self.keywordEngine.index.has(token)) self.keywordEngine.index.set(token, []);
        self.keywordEngine.index.get(token).push(chunk.id);
      });
      self.keywordEngine.documents.push({
        id: chunk.id,
        path: '',
        title: chunk.docTitle + (chunk.heading ? ' > ' + chunk.heading : ''),
        content: chunk.text,
        tokens: tokens,
      });
    });
  }

  async _embedChunks(chunks, onProgress) {
    var self = this;
    var config = this.embeddingConfig;
    var batchSize = config.batchSize || 10;
    var vectors = [];
    var progressCb = onProgress || function() {};

    for (var i = 0; i < chunks.length; i += batchSize) {
      var batch = chunks.slice(i, Math.min(i + batchSize, chunks.length));
      var texts = batch.map(function(c) { return c.text.slice(0, 2000); });

      try {
        var embs = await self._callEmbedding(texts, config);
        for (var j = 0; j < embs.length; j++) {
          var n = norm(embs[j]);
          vectors.push({ chunkId: batch[j].id, vector: embs[j], norm: n || 1 });
        }
      } catch(e) {
        console.error('[RAGEngine] Embed chunk batch failed:', e.message);
        for (var k = 0; k < batch.length; k++) {
          vectors.push({ chunkId: batch[k].id, vector: [], norm: 0 });
        }
      }

      // Report progress
      progressCb({
        phase: 'embed_progress',
        message: '向量化: ' + Math.min(i + batchSize, chunks.length) + '/' + chunks.length,
        current: Math.min(i + batchSize, chunks.length),
        total: chunks.length,
      });
    }
    return vectors;
  }

  /**
   * 向量化一批文本：先查共享磁盘缓存（tools/embedding.js），逐条命中直接复用；
   * 未命中的合并为一次 API 调用（_callEmbeddingApi），回来后写缓存并落盘。
   * 返回数组与输入 texts 等长对齐，未向量化成功的位置为 []（norm=0，不参与向量检索）。
   */
  async _callEmbedding(texts, config) {
    var results = new Array(texts.length).fill(null);
    var pending = [];
    for (var i = 0; i < texts.length; i++) {
      var cachedVec = embeddingStore.getCached(texts[i]);
      if (cachedVec) results[i] = cachedVec;
      else pending.push({ index: i, text: texts[i] });
    }

    if (pending.length) {
      var fetched = await this._callEmbeddingApi(pending.map(function(p) { return p.text; }), config);
      if (!Array.isArray(fetched) || fetched.length !== pending.length) {
        throw new Error('Embedding API returned ' + (fetched ? fetched.length : 'no') + ' vectors for ' + pending.length + ' inputs');
      }
      for (var j = 0; j < pending.length; j++) {
        var vec = fetched[j];
        if (vec && vec.length) {
          results[pending[j].index] = vec;
          embeddingStore.storeCached(pending[j].text, vec);
        }
      }
      embeddingStore.saveCache();
    }

    return results.map(function(v) { return Array.isArray(v) ? v : []; });
  }

  _callEmbeddingApi(texts, config) {
    return new Promise(function(resolve, reject) {
      var body = JSON.stringify({
        model: config.model || 'text-embedding-v4',
        input: texts.length === 1 ? texts[0] : texts,
      });
      var req = https.request({
        hostname: config.host || 'dashscope.aliyuncs.com',
        port: 443,
        path: config.path || '/compatible-mode/v1/embeddings',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      }, function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(data);
            if (json.error) { reject(new Error(json.error.message || 'API error')); return; }
            var embeddings = (json.data || []).map(function(d) { return d.embedding; });
            resolve(embeddings);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async _vectorSearch(query, topK) {
    var self = this;
    return new Promise(function(resolve) {
      self._callEmbedding([query], self.embeddingConfig).then(function(queryVecs) {
        var qVec = queryVecs[0];
        var qNorm = norm(qVec) || 1;
        if (!qVec || !qVec.length) { resolve([]); return; }

        var scores = self.vectors.map(function(v) {
          if (!v.vector || !v.vector.length) return { id: v.chunkId, score: 0 };
          var dot = dotProduct(qVec, v.vector);
          return { id: v.chunkId, title: self._chunkTitle(v.chunkId), score: v.norm > 0 ? dot / (qNorm * v.norm) : 0 };
        });

        scores.sort(function(a, b) { return b.score - a.score; });
        resolve(scores.slice(0, topK).filter(function(s) { return s.score > 0; }));
      }).catch(function() { resolve([]); });
    });
  }

  _chunkTitle(chunkId) {
    var chunk = this.chunks.find(function(c) { return c.id === chunkId; });
    return chunk ? (chunk.docTitle + (chunk.heading ? ' > ' + chunk.heading : '')) : chunkId;
  }

  _hydrateCachedVectors(vectors) {
    return (vectors || []).map(function(item) {
      if (Array.isArray(item.vector)) return { chunkId: item.chunkId, vector: item.vector, norm: item.norm };
      if (Array.isArray(item.sparse)) {
        var length = item.sparse.reduce(function(max, pair) { return Math.max(max, Number(pair[0]) + 1); }, 0);
        var dense = new Array(length).fill(0);
        item.sparse.forEach(function(pair) { dense[Number(pair[0])] = Number(pair[1]); });
        return { chunkId: item.chunkId, vector: dense, norm: item.norm };
      }
      return { chunkId: item.chunkId, vector: [], norm: item.norm || 0 };
    });
  }

  /**
   * Re-embed a single chunk after a manual edit. Updates this.vectors in memory
   * only — the caller persists via _saveCache. Never throws: on failure the
   * chunk is flagged vectorStale so keyword search stays correct and the UI
   * can prompt a rebuild.
   */
  async reembedChunk(chunkId) {
    var chunk = this.chunks.find(function(c) { return c.id === chunkId; });
    if (!chunk) return { ok: false, stale: true, error: 'chunk not found: ' + chunkId };
    if (!this.embeddingConfig || !this.embeddingConfig.apiKey) {
      chunk.vectorStale = true;
      return { ok: false, stale: true, error: 'no embedding config' };
    }
    try {
      var embs = await this._callEmbedding([String(chunk.text || '').slice(0, 2000)], this.embeddingConfig);
      var vec = embs && embs[0];
      if (!vec || !vec.length) throw new Error('empty embedding returned');
      var n = norm(vec) || 1;
      var existing = this.vectors.find(function(v) { return v.chunkId === chunkId; });
      if (existing) { existing.vector = vec; existing.norm = n; }
      else this.vectors.push({ chunkId: chunkId, vector: vec, norm: n });
      chunk.vectorStale = false;
      return { ok: true, norm: n };
    } catch(e) {
      chunk.vectorStale = true;
      return { ok: false, stale: true, error: e.message };
    }
  }

  _saveCache(cacheFile) {
    var tempPath = cacheFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      var data = {
        version: 6,
        source_digest: this.stats && this.stats.source_digest || null,
        configuration_digest: this.stats && this.stats.configuration_digest || null,
        index_digest: this.stats && this.stats.index_digest || null,
        stats: this.stats,
        chunks: this.chunks.map(function(c) { return this._cacheChunk(c); }, this),
        vectors: this.vectors.map(function(v) { return this._cacheVector(v); }, this),
      };
      fs.writeFileSync(tempPath, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tempPath, cacheFile);
    } catch(e) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      var failure = new Error('RAG cache persistence failed');
      failure.code = 'RAG_CACHE_WRITE_FAILED';
      throw failure;
    }
  }
}

// ── Vector math ──
function dotProduct(a, b) {
  var sum = 0;
  for (var i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v) {
  var sum = 0;
  for (var i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

module.exports = { RAGEngine };
