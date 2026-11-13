/**
 * Multi-format Document Parser
 *
 * Parses PDF, DOCX, PPTX files into structured markdown text.
 * Uses native JS libraries — no Python dependency.
 *
 * Usage:
 *   const { parseFile, getFileType } = require('./tools/multi-format-parser');
 *   const result = await parseFile('/path/to/doc.pdf');
 *   // result: { text, images, tables, metadata }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── File type detection ──

const EXT_MAP = {
  '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx',
  '.xlsx': 'xlsx', '.xlsm': 'xlsm', '.xls': 'xls',
  '.md': 'markdown', '.txt': 'text', '.csv': 'csv',
  '.json': 'json', '.xml': 'xml', '.html': 'html', '.htm': 'html',
};

function getFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MAP[ext] || 'unknown';
}

// ── Main parse function ──

async function parseFile(filePath, options) {
  const opts = options || {};
  const type = getFileType(filePath);

  if (!fs.existsSync(filePath)) {
    throw new Error('File not found: ' + filePath);
  }

  const metadata = {
    fileName: path.basename(filePath),
    filePath: filePath,
    type: type,
    size: fs.statSync(filePath).size,
    hash: await computeHash(filePath),
    parsedAt: new Date().toISOString(),
  };

  let result;

  switch (type) {
    case 'pdf':
      result = await parsePDF(filePath, opts);
      break;
    case 'docx':
      result = await parseDOCX(filePath, opts);
      break;
    case 'pptx':
      result = await parsePPTX(filePath, opts);
      break;
    case 'xlsx':
    case 'xlsm':
    case 'xls':
      result = await parseXLSX(filePath, opts);
      break;
    case 'markdown':
    case 'text':
    case 'csv':
    case 'json':
    case 'xml':
    case 'html':
      result = { text: fs.readFileSync(filePath, 'utf-8'), images: [], tables: [] };
      break;
    default:
      // Try as text
      try {
        result = { text: fs.readFileSync(filePath, 'utf-8'), images: [], tables: [] };
      } catch (e) {
        throw new Error('Unsupported file type: ' + type);
      }
  }

  return { ...result, metadata };
}

// ── PDF Parser ──

function parsePDF(filePath, opts) {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    return pdfParse(dataBuffer).then(function (data) {
      var rawText = data.text || '';
      // Extract tables from text: detect consecutive lines with multiple | or tab-separated columns
      var tables = extractTablesFromText(rawText);
      return {
        text: rawText,
        images: [],
        tables: tables,
        pageCount: data.numpages,
        info: data.info || {},
      };
    });
  } catch (e) {
    // Graceful fallback
    return Promise.resolve({
      text: '[PDF parsing failed: ' + e.message + ']',
      images: [],
      tables: [],
      error: e.message,
    });
  }
}

// ── DOCX Parser ──

function parseDOCX(filePath, opts) {
  try {
    const mammoth = require('mammoth');
    // Use convertToHtml to preserve table structure, then convert to markdown tables
    return mammoth.convertToHtml({ path: filePath }).then(function (result) {
      var html = result.value || '';
      // Convert HTML tables to markdown tables
      var tables = extractTablesFromHtml(html);
      // Also get plain text for non-table content
      return mammoth.extractRawText({ path: filePath }).then(function (rawResult) {
        var rawText = rawResult.value || '';
        // Convert html tables to markdown and append to text
        var tableMarkdown = tables.map(function(t, i) {
          return '\n\n## 表格 ' + (i + 1) + '\n\n' + t.markdown;
        }).join('');
        return {
          text: rawText + tableMarkdown,
          images: [],
          tables: tables,
          warnings: result.messages || [],
        };
      });
    }).catch(function (err) {
      return {
        text: '[DOCX parsing failed: ' + err.message + ']',
        images: [],
        tables: [],
        error: err.message,
      };
    });
  } catch (e) {
    return Promise.resolve({
      text: '[DOCX parser not available: ' + e.message + ']',
      images: [],
      tables: [],
      error: e.message,
    });
  }
}

// ── PPTX Parser (ZIP + XML) ──

function parsePPTX(filePath, opts) {
  return new Promise(function (resolve) {
    try {
      const AdmZip = require('adm-zip');
      let zip;
      try {
        zip = new AdmZip(filePath);
      } catch (e) {
        // Try node:zlib built-in
        const zlib = require('zlib');
        const buf = fs.readFileSync(filePath);
        // PPTX is a standard ZIP — try built-in unzip
        return resolve({
          text: '[PPTX binary — requires adm-zip npm package for parsing]',
          images: [],
          tables: [],
          error: 'adm-zip not available',
        });
      }

      const slides = [];
      const entries = zip.getEntries();

      // Extract text from slide XML files
      entries.forEach(function (entry) {
        const name = entry.entryName;
        if (/ppt\/slides\/slide\d+\.xml/.test(name)) {
          try {
            const xml = entry.getData().toString('utf8');
            // Extract all <a:t> text nodes
            const texts = [];
            const tagRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
            let match;
            while ((match = tagRe.exec(xml)) !== null) {
              const t = match[1].trim();
              if (t) texts.push(t);
            }
            if (texts.length) {
              slides.push({ slide: name.replace('ppt/slides/', '').replace('.xml', ''), text: texts.join('\n') });
            }
          } catch (e) { /* skip corrupt slide */ }
        }
      });

      const text = slides.map(function (s) {
        return '## Slide ' + s.slide + '\n\n' + s.text;
      }).join('\n\n---\n\n');

      resolve({
        text: text || '[No slide text extracted]',
        images: [],
        tables: [],
        slideCount: slides.length,
      });
    } catch (e) {
      resolve({
        text: '[PPTX parsing failed: ' + e.message + ']',
        images: [],
        tables: [],
        error: e.message,
      });
    }
  });
}

// ── XLSX Parser ──

function parseXLSX(filePath, opts) {
  try {
    const AdmZip = require('adm-zip');
    let zip;
    try {
      zip = new AdmZip(filePath);
    } catch (e) {
      return Promise.resolve({
        text: '[XLSX binary — requires adm-zip or dedicated parser]',
        images: [],
        tables: [],
      });
    }

    // Read shared strings
    let sharedStrings = [];
    try {
      const ssEntry = zip.getEntry('xl/sharedStrings.xml');
      if (ssEntry) {
        const ssXml = ssEntry.getData().toString('utf8');
        const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
        let match;
        while ((match = siRe.exec(ssXml)) !== null) {
          const tMatch = match[1].match(/<t[^>]*>([^<]*)<\/t>/);
          sharedStrings.push(tMatch ? tMatch[1] : '');
        }
      }
    } catch (e) { /* no shared strings */ }

    // Read ALL sheets and convert to markdown tables
    var tables = [];
    var textParts = [];
    try {
      var entries = zip.getEntries();
      var sheetFiles = entries.filter(function(e) {
        return /xl\/worksheets\/sheet\d+\.xml/.test(e.entryName);
      }).sort(function(a, b) {
        return a.entryName.localeCompare(b.entryName, undefined, { numeric: true });
      });

      sheetFiles.forEach(function(sheetEntry) {
        var sheetName = sheetEntry.entryName.replace('xl/worksheets/', '').replace('.xml', '');
        var sheetXml = sheetEntry.getData().toString('utf8');
        var rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
        var rowMatch;
        var rows = [];

        while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
          var vals = [];
          var vRe = /<c[^>]*r="([A-Z]+)(\d+)"[^>]*>[\s\S]*?<v[^>]*>([^<]*)<\/v>/g;
          var vMatch;
          while ((vMatch = vRe.exec(rowMatch[1])) !== null) {
            var vidx = parseInt(vMatch[3], 10);
            vals.push(sharedStrings[vidx] || vMatch[3]);
          }
          if (vals.length) rows.push(vals);
        }

        if (rows.length) {
          // Convert to markdown table
          var md = rows.map(function(r) { return '| ' + r.join(' | ') + ' |'; }).join('\n');
          // Add separator after first row (header)
          if (rows.length > 1) {
            var firstCols = rows[0].length;
            var sep = '| ' + new Array(firstCols).fill('---').join(' | ') + ' |';
            md = md.split('\n');
            md.splice(1, 0, sep);
            md = md.join('\n');
          }
          tables.push({ sheet: sheetName, markdown: md, rowCount: rows.length });
          textParts.push('## ' + sheetName + '\n\n' + md);
        }
      });
    } catch (e) { /* no sheet data */ }

    return Promise.resolve({
      text: textParts.join('\n\n---\n\n') || '[No sheet data extracted]',
      images: [],
      tables: tables,
    });
  } catch (e) {
    return Promise.resolve({
      text: '[XLSX parsing failed: ' + e.message + ']',
      images: [],
      tables: [],
      error: e.message,
    });
  }
}

// ── Hash ──

function computeHash(filePath) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', function (d) { hash.update(d); });
    stream.on('end', function () { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

// ── Table Extraction Helpers ──

/**
 * Extract tables from plain text by detecting tab-separated or pipe-separated consecutive lines.
 * Returns array of { markdown, rowCount, colCount }
 */
function extractTablesFromText(text) {
  var tables = [];
  var lines = text.split('\n');
  var i = 0;

  while (i < lines.length) {
    var line = lines[i];
    // Detect potential table row: contains tab or multiple |
    var isTabRow = line.split('\t').length >= 3;
    var isPipeRow = (line.match(/\|/g) || []).length >= 2;

    if (isTabRow || isPipeRow) {
      var tableLines = [];
      var sep = isTabRow ? '\t' : '|';

      // Collect consecutive table-like lines
      while (i < lines.length) {
        var l = lines[i];
        if (l.split(sep).length >= 2 && l.trim()) {
          tableLines.push(l);
          i++;
        } else {
          break;
        }
      }

      if (tableLines.length >= 2) {
        // Convert to markdown table
        var rows = tableLines.map(function(l) {
          var cells = l.split(sep).map(function(c) { return c.trim(); });
          if (sep === '|') {
            // 行首尾的 | 是行定界符而非单元格分隔符，去掉其产生的空单元格
            if (cells.length > 1 && cells[0] === '') cells.shift();
            if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
          }
          return cells;
        });
        var md = rows.map(function(r) { return '| ' + r.join(' | ') + ' |'; }).join('\n');
        // Add separator after first row
        if (rows.length > 1) {
          var cols = rows[0].length;
          var sepRow = '| ' + new Array(cols).fill('---').join(' | ') + ' |';
          md = md.split('\n');
          md.splice(1, 0, sepRow);
          md = md.join('\n');
        }
        tables.push({
          markdown: md,
          rowCount: rows.length,
          colCount: rows[0].length,
        });
      }
    } else {
      i++;
    }
  }

  return tables;
}

/**
 * Extract tables from HTML by parsing <table> elements.
 * Returns array of { markdown, rowCount, colCount, html }
 */
function extractTablesFromHtml(html) {
  var tables = [];
  var tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  var match;

  while ((match = tableRe.exec(html)) !== null) {
    var tableHtml = match[1];
    var rows = [];
    var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    var trMatch;

    while ((trMatch = trRe.exec(tableHtml)) !== null) {
      var rowHtml = trMatch[1];
      var cells = [];
      var tdRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
      var tdMatch;
      while ((tdMatch = tdRe.exec(rowHtml)) !== null) {
        // Strip inner HTML tags, keep text
        var cellText = tdMatch[2].replace(/<[^>]+>/g, '').trim();
        cells.push(cellText);
      }
      if (cells.length) rows.push(cells);
    }

    if (rows.length >= 1) {
      var md = rows.map(function(r) { return '| ' + r.join(' | ') + ' |'; }).join('\n');
      if (rows.length > 1) {
        var cols = rows[0].length;
        var sepRow = '| ' + new Array(cols).fill('---').join(' | ') + ' |';
        md = md.split('\n');
        md.splice(1, 0, sepRow);
        md = md.join('\n');
      }
      tables.push({
        markdown: md,
        rowCount: rows.length,
        colCount: rows[0].length,
        html: match[0],
      });
    }
  }

  return tables;
}

module.exports = { parseFile, getFileType, extractTablesFromText, extractTablesFromHtml };
