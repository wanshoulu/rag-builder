/**
 * BM25 Keyword Engine — 轻量关键词检索（原 llm-wiki-engine SearchEngine 的内联版）
 *
 * 专为 rag-builder 裁剪：只保留混合检索所需的 tokenize / 倒排索引 / BM25 打分 / 摘要片段。
 * 中文使用 CJK bigram + 单字，英文按词边界；IDF 使用 Lucene-smooth 公式（高频词不为零）。
 *
 * 与原 SearchEngine 行为一致：k1=1.2, b=0.75, idf=ln((N+1)/(df+0.5))。
 */

'use strict';

class BM25Engine {
  constructor() {
    this.index = new Map();    // token → [docId, ...]
    this.documents = [];       // [{id, title, content, tokens}]
  }

  /**
   * 由调用方直接填充 index/documents（rag-engine._buildKeywordIndex 绕过 buildIndex 使用此结构）
   */
  reset() {
    this.index = new Map();
    this.documents = [];
  }

  /**
   * BM25 搜索
   * @param {string} query
   * @param {object} options - { topK }
   * @returns [{ id, title, score, snippet }]
   */
  search(query, options) {
    var opts = options || {};
    var topK = opts.topK || 10;
    var queryTokens = this.tokenize(query);

    if (!this.documents.length) return [];

    var scores = new Map();
    var avgDocLength = this.documents.reduce(function(sum, doc) { return sum + doc.tokens.length; }, 0)
      / this.documents.length;
    var k1 = 1.2;
    var b = 0.75;
    var docMap = new Map(this.documents.map(function(d) { return [d.id, d]; }));

    queryTokens.forEach(function(token) {
      var postings = this.index.get(token) || [];
      // postings 按 token 出现次数填充（同一 docId 会出现多次），
      // df 必须按去重后的文档数计算，否则高频词 idf 为负、tf 被二次放大
      var seen = new Set();
      var idf = 0;
      postings.forEach(function(docId) { seen.add(docId); });
      var df = seen.size;
      if (df > 0) idf = Math.log((this.documents.length + 1) / (df + 0.5)); // Lucene-smooth IDF

      seen.forEach(function(docId) {
        var doc = docMap.get(docId);
        if (!doc) return;

        var tf = doc.tokens.filter(function(t) { return t === token; }).length;
        var score = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.tokens.length / avgDocLength)));
        scores.set(docId, (scores.get(docId) || 0) + score);
      });
    }, this);

    return Array.from(scores.entries())
      .sort(function(a, b2) { return b2[1] - a[1]; })
      .slice(0, topK)
      .map(function(entry) {
        var docId = entry[0];
        var score = entry[1];
        var doc = docMap.get(docId);
        return {
          id: docId,
          title: (doc && doc.title) || docId,
          score: score,
          snippet: this.getSnippet((doc && doc.content) || '', query),
        };
      }, this);
  }

  /**
   * 分词：英文按词边界，中文 CJK bigram + 单字（子串匹配用）
   */
  tokenize(text) {
    var cleaned = String(text || '').toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, ' ');
    var words = cleaned.split(/\s+/).filter(function(t) { return t.length > 0; });

    var tokens = [];
    words.forEach(function(w) {
      // 完整词作为 token（英文/精确 CJK 短语匹配）
      if (w.length > 1) tokens.push(w);
      // CJK 额外生成 bigram + 单字
      if (/^[\u4e00-\u9fa5]+$/.test(w)) {
        for (var i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
        for (var j = 0; j < w.length; j++) tokens.push(w[j]);
      }
    });
    return tokens;
  }

  /**
   * 提取查询命中处的摘要片段
   */
  getSnippet(text, query, maxLength) {
    var max = maxLength || 200;
    var lowerText = String(text || '').toLowerCase();
    var lowerQuery = String(query || '').toLowerCase();

    var pos = lowerText.indexOf(lowerQuery);
    if (pos === -1) return text.slice(0, max) + '...';

    var start = Math.max(0, pos - 50);
    var end = Math.min(text.length, pos + query.length + 150);
    return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
  }
}

module.exports = { BM25Engine };
