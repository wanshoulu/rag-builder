/**
 * Text Chunker — configurable chunking strategies for RAG pipeline
 *
 * Strategies:
 *   - auto:          automatically detect document type and pick best strategy
 *   - fixed_size:    splits by char count with overlap, breaks at newline/sentence
 *   - markdown:      splits on ## headings, sub-chunks oversized sections
 *   - recursive:     tries paragraph → sentence → word boundaries in order
 *   - parent_child:  small child chunks for search + large parent chunks for context
 *   - sentence:      splits on sentence boundaries (。！？.!?)
 *   - paragraph:     splits on double-newline paragraph boundaries
 *
 * Usage:
 *   const { chunkDocument, previewChunks } = require('./tools/chunker');
 *   const chunks = chunkDocument(content, { strategy: 'auto', chunkSize: 1024 });
 *   const preview = previewChunks(content, { strategy: 'markdown', chunkSize: 1024 });
 */

'use strict';

/**
 * Main entry: chunk a single document.
 */
function chunkDocument(content, options) {
  var opts = options || {};
  var strategy = opts.strategy || 'markdown';
  var chunkSize = opts.chunkSize || 1024;
  var overlap = opts.overlap || 128;
  var minChunkSize = opts.minChunkSize || 100;

  if (!content || content.trim().length === 0) return [];

  var text = content.replace(/^---[\s\S]*?---\n*/, '').trim();
  if (!text) return [];

  // Auto-detect document type and pick best strategy
  var docType = 'unknown';
  if (strategy === 'auto') {
    var detected = detectDocumentType(text, opts.metadata);
    strategy = detected.strategy;
    docType = detected.docType;
    // Apply recommended defaults if user didn't override
    if (!opts.chunkSize && detected.chunkSize) chunkSize = detected.chunkSize;
    if (!opts.overlap && detected.overlap) overlap = detected.overlap;
  }

  var chunks;
  switch (strategy) {
    case 'fixed_size': chunks = fixedSizeChunk(text, chunkSize, overlap, minChunkSize); break;
    case 'recursive': chunks = recursiveChunk(text, chunkSize, overlap, minChunkSize); break;
    case 'sentence': chunks = sentenceChunk(text, chunkSize, overlap, minChunkSize); break;
    case 'paragraph': chunks = paragraphChunk(text, chunkSize, overlap, minChunkSize); break;
    case 'parent_child': chunks = parentChildChunk(text, opts.childSize||512, opts.parentSize||2048, overlap, minChunkSize); break;
    case 'markdown':
    default: chunks = markdownChunk(text, chunkSize, overlap, minChunkSize);
  }

  // Attach metadata to each chunk
  var docMeta = opts.metadata || {};
  chunks.forEach(function(c) {
    c.metadata = {
      docType: docMeta.type || docType,
      docSource: docMeta.fileName || '',
      parsedAt: docMeta.parsedAt || new Date().toISOString(),
      chunkStrategy: strategy,
    };
  });

  return chunks;
}

/**
 * Auto-detect document type and recommend best chunking strategy.
 * Heuristics:
 *   - Many ## headings + short paragraphs → markdown (tech docs, wiki)
 *   - Many tables (|...|) → markdown (preserve table structure)
 *   - Long paragraphs, few headings → recursive (reports, articles)
 *   - Q&A patterns (问题/answer, Q:/A:) → sentence (FAQ)
 *   - Short text (< 500 chars) → fixed_size (avoid over-fragmentation)
 */
function detectDocumentType(text, metadata) {
  var headingCount = (text.match(/^#{1,3}\s/gm) || []).length;
  var tableCount = (text.match(/^\|.*\|/gm) || []).length;
  var paragraphCount = (text.match(/\n\n+/g) || []).length;
  var qaPattern = (text.match(/^(问题|Q[:：]|A[:：]|\d+[.、])/gm) || []).length;
  var codeBlockCount = (text.match(/```/g) || []).length / 2;
  var totalLen = text.length;

  // Short document — keep as single chunk
  if (totalLen < 500) {
    return { strategy: 'fixed_size', chunkSize: 1024, overlap: 64, docType: 'short' };
  }

  // FAQ pattern
  if (qaPattern >= 3 && qaPattern > headingCount) {
    return { strategy: 'sentence', chunkSize: 768, overlap: 64, docType: 'faq' };
  }

  // Has tables or many headings → markdown-aware
  if (tableCount >= 3 || (headingCount >= 3 && codeBlockCount >= 1)) {
    return { strategy: 'markdown', chunkSize: 1024, overlap: 128, docType: 'technical' };
  }

  // Wiki-style with headings
  if (headingCount >= 2 && paragraphCount >= 3) {
    return { strategy: 'markdown', chunkSize: 1024, overlap: 128, docType: 'wiki' };
  }

  // Long-form text with few structural markers → recursive
  if (paragraphCount >= 2) {
    return { strategy: 'recursive', chunkSize: 1024, overlap: 128, docType: 'article' };
  }

  // Default fallback
  return { strategy: 'markdown', chunkSize: 1024, overlap: 128, docType: 'unknown' };
}

/**
 * Fixed-size chunking: count characters, split at chunkSize, overlap
 */
function fixedSizeChunk(text, chunkSize, overlap, minChunkSize) {
  var chunks = [];
  var len = text.length;
  var start = 0;

  while (start < len) {
    var end = Math.min(start + chunkSize, len);
    // Try to break at newline or sentence boundary
    if (end < len) {
      var breakPos = findBreakPoint(text, end, start + chunkSize / 2);
      if (breakPos > start) end = breakPos;
    }
    var chunk = text.slice(start, end).trim();
    if (chunk.length >= minChunkSize) {
      chunks.push({ text: chunk, charCount: chunk.length, tokenEstimate: Math.ceil(chunk.length / 3) });
    }
    if (end >= len) break;
    var nextStart = Math.max(0, end - overlap);
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}

/**
 * Markdown-aware chunking: split on ## headings, sub-chunk oversized sections
 */
function markdownChunk(text, chunkSize, overlap, minChunkSize) {
  var chunks = [];
  // Split by ## heading boundaries
  var sections = text.split(/\n(?=## )/);
  var heading = '';

  sections.forEach(function(section) {
    var headingMatch = section.match(/^## (.+)$/m);
    var sectionHeading = headingMatch ? headingMatch[1].trim() : heading;

    if (section.length <= chunkSize) {
      // Small section — keep as one chunk
      if (section.trim().length >= minChunkSize) {
        chunks.push({
          text: section.trim(),
          charCount: section.trim().length,
          tokenEstimate: Math.ceil(section.trim().length / 3),
          heading: sectionHeading || undefined,
        });
      }
    } else {
      // Large section — sub-chunk
      var subChunks = fixedSizeChunk(section, chunkSize, overlap, minChunkSize);
      subChunks.forEach(function(sc) {
        sc.heading = sectionHeading || undefined;
        chunks.push(sc);
      });
    }
    heading = sectionHeading;
  });

  return chunks;
}

/**
 * Recursive chunking: try paragraph → sentence → word boundaries
 */
function recursiveChunk(text, chunkSize, overlap, minChunkSize) {
  // First try paragraph splits
  var paragraphs = text.split(/\n\n+/);
  var chunks = [];

  paragraphs.forEach(function(para) {
    var trimmed = para.trim();
    if (!trimmed) return;
    if (trimmed.length <= chunkSize) {
      if (trimmed.length >= minChunkSize) {
        chunks.push({ text: trimmed, charCount: trimmed.length, tokenEstimate: Math.ceil(trimmed.length / 3) });
      }
    } else {
      // Try sentence splits
      var sentences = trimmed.split(/(?<=[。！？.!?])\s*/);
      var current = '';
      sentences.forEach(function(sent) {
        if ((current + sent).length > chunkSize && current.length >= minChunkSize) {
          chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
          // Overlap: keep last few chars
          var overlapText = current.slice(-overlap);
          current = overlapText + sent;
        } else {
          current += sent;
        }
      });
      if (current.trim().length >= minChunkSize) {
        chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
      }
    }
  });

  return chunks;
}

/**
 * Parent-child chunking: small child chunks for precise search,
 * large parent chunks for complete context injection into LLM.
 * Each child chunk links to its parent via parentId.
 */
function parentChildChunk(text, childSize, parentSize, overlap, minChunkSize) {
  childSize = childSize || 512;
  parentSize = parentSize || 2048;
  overlap = overlap || 64;
  minChunkSize = minChunkSize || 50;

  // Create parent chunks (large context windows)
  var parents = fixedSizeChunk(text, parentSize, overlap, minChunkSize);
  var results = [];
  var chunkIdx = 0;

  parents.forEach(function(parent, pi) {
    var parentId = 'parent_' + pi;
    // Add parent as a chunk
    results.push({
      id: parentId,
      text: parent.text,
      charCount: parent.charCount,
      tokenEstimate: parent.tokenEstimate,
      isParent: true,
    });

    // Create child chunks within this parent
    var children = fixedSizeChunk(parent.text, childSize, Math.floor(overlap/2), minChunkSize);
    children.forEach(function(child) {
      results.push({
        id: 'child_' + pi + '_' + chunkIdx,
        text: child.text,
        charCount: child.charCount,
        tokenEstimate: child.tokenEstimate,
        parentId: parentId,
        isChild: true,
      });
      chunkIdx++;
    });
  });

  return results;
}

/**
 * Sentence-level chunking: split on Chinese/English sentence boundaries
 */
function sentenceChunk(text, chunkSize, overlap, minChunkSize) {
  var sentences = text.split(/(?<=[。！？.!?])\s*/);
  var chunks = [];
  var current = '';

  sentences.forEach(function(sent) {
    if ((current + sent).length > chunkSize && current.length >= minChunkSize) {
      chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
      current = current.slice(-overlap) + sent;
    } else {
      current += sent;
    }
  });
  if (current.trim().length >= minChunkSize) {
    chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
  }
  return chunks;
}

/**
 * Paragraph-level chunking: split on double-newline boundaries
 */
function paragraphChunk(text, chunkSize, overlap, minChunkSize) {
  var paragraphs = text.split(/\n\n+/);
  var chunks = [];
  var current = '';

  paragraphs.forEach(function(para) {
    para = para.trim();
    if (!para) return;
    if (para.length <= chunkSize) {
      if ((current + '\n\n' + para).length > chunkSize) {
        if (current.length >= minChunkSize) {
          chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
        }
        current = para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
    } else {
      if (current.length >= minChunkSize) {
        chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
      }
      current = '';
      var sub = fixedSizeChunk(para, chunkSize, overlap, minChunkSize);
      chunks = chunks.concat(sub);
    }
  });
  if (current.trim().length >= minChunkSize) {
    chunks.push({ text: current.trim(), charCount: current.trim().length, tokenEstimate: Math.ceil(current.trim().length / 3) });
  }
  return chunks;
}

/**
 * Preview chunks for a document without building the full index.
 * Returns chunk metadata so users can adjust settings before committing.
 */
function previewChunks(content, options) {
  var chunks = chunkDocument(content, options);
  var total = chunks.length;
  var totalChars = 0;
  var minChars = Infinity, maxChars = 0;
  for (var i = 0; i < total; i++) {
    var cc = chunks[i].charCount;
    totalChars += cc;
    if (cc < minChars) minChars = cc;
    if (cc > maxChars) maxChars = cc;
  }
  if (total === 0) minChars = 0;

  // Completeness check: detect potential semantic breaks
  var warnings = [];
  for (var j = 0; j < total; j++) {
    var c = chunks[j];
    // Check if chunk ends mid-sentence (no sentence-ending punctuation)
    var lastChar = c.text.trim().slice(-1);
    if (lastChar && !'.。!！?？)]}"\''.includes(lastChar) && j < total - 1) {
      warnings.push({
        chunkIndex: j,
        type: 'mid_sentence',
        message: '分块可能在句子中间断开',
        tail: c.text.slice(-50),
      });
    }
    // Check if chunk starts with lowercase/continuation
    var firstChar = c.text.trim().charAt(0);
    if (j > 0 && firstChar && /[a-z,，、)]/.test(firstChar)) {
      warnings.push({
        chunkIndex: j,
        type: 'mid_break',
        message: '分块可能从上一块中间开始',
        head: c.text.slice(0, 50),
      });
    }
  }

  return {
    totalChunks: total,
    totalChars: totalChars,
    avgChars: total ? Math.round(totalChars / total) : 0,
    minChars: minChars,
    maxChars: maxChars,
    warnings: warnings,
    samples: chunks.slice(0, 5).map(function(c, i) {
      return { index: i, charCount: c.charCount, preview: c.text.slice(0, 200), heading: c.heading, isChild: c.isChild, parentId: c.parentId, metadata: c.metadata };
    }),
    chunks: chunks,
  };
}

/**
 * Find a good break point near the target position.
 * Prefers: newline > sentence end > space > hard cut
 */
function findBreakPoint(text, target, minPos) {
  // Try newline
  var nl = text.lastIndexOf('\n', target);
  if (nl > minPos) return nl + 1;

  // Try sentence boundary (Chinese/English)
  var sentMatch = text.slice(minPos, target).match(/[。！？.!?]\s*/g);
  if (sentMatch && sentMatch.length) {
    var lastIdx = text.slice(minPos, target).lastIndexOf(sentMatch[sentMatch.length - 1]);
    if (lastIdx >= 0) return minPos + lastIdx + 1;
  }

  // Try space
  var sp = text.lastIndexOf(' ', target);
  if (sp > minPos) return sp + 1;

  return target;
}

/**
 * Chunk all documents in a wiki directory
 * @param {Array} documents - [{id, title, content, metadata?}]
 * @param {object} options - chunking options
 * @returns {Array} flat array of chunks with docId, docTitle, metadata
 */
function chunkDocuments(documents, options) {
  var allChunks = [];
  var chunkIdx = 0;

  documents.forEach(function(doc) {
    var chunkOpts = Object.assign({}, options);
    if (doc.metadata) chunkOpts.metadata = doc.metadata;
    var chunks = chunkDocument(doc.content || '', chunkOpts);
    chunks.forEach(function(c) {
      c.id = doc.id + '#chunk' + chunkIdx;
      c.docId = doc.id;
      c.docTitle = doc.title || doc.id;
      c.chunkIndex = chunkIdx;
      allChunks.push(c);
      chunkIdx++;
    });
  });

  return allChunks;
}

module.exports = { chunkDocument, chunkDocuments, previewChunks };
