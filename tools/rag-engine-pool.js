'use strict';

/**
 * RAGEngine 实例池 — 知识库级单例层。
 * HTTP 路由与检索调用方必须共享同一实例，否则会出现双份内存索引
 * 和 .rag-cache.json 并发写冲突。
 */

const path = require('node:path');
const { RAGEngine } = require('./rag-engine');
const embedding = require('./embedding');

const DATA_ROOT = process.env.RAG_DATA_ROOT || path.join(__dirname, '..', 'data');
const KB_ROOT = path.join(DATA_ROOT, 'kb');

const engines = new Map(); // kbName → RAGEngine

function getOrCreateRAGEngine(kbName) {
  var key = kbName || '__root__';
  if (!engines.has(key)) {
    engines.set(key, new RAGEngine({
      kbRoot: KB_ROOT,
      embeddingConfig: embedding.getEmbeddingConfig(),
    }));
  }
  return engines.get(key);
}

function reset() {
  engines.clear();
}

module.exports = { getOrCreateRAGEngine: getOrCreateRAGEngine, getEmbeddingConfig: embedding.getEmbeddingConfig, KB_ROOT: KB_ROOT, reset: reset };
