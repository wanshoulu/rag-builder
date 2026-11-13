'use strict';

/**
 * API Keys — 模型路由注册表（单一事实来源，env-only）
 *
 * 本仓库不提交任何真实密钥：所有 key 一律通过环境变量注入。
 *   QWEN_KEY      — DashScope（通义 text-embedding-v4 嵌入）；未配置时自动降级 TF-IDF 关键词向量
 *   DEEPSEEK_KEY  — DeepSeek（deepseek-chat 答案生成）；未配置时 /api/rag/answer 返回 RETRIEVAL_ONLY
 *
 * 消费方：tools/knowledge-rag-answer-service.js（require('../config/api-keys') 后按模型名取路由）。
 * 配置方式：复制 .env.example → .env（或直接 export），按需填入。
 */

const API_ROUTES = {
  'text-embedding-v4': {
    host: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/embeddings',
    model: 'text-embedding-v4',
    dim: 1024,
    batchSize: 10,
    getKey: () => process.env.QWEN_KEY,
    provider: 'qwen',
  },
  'deepseek-chat': {
    host: 'api.deepseek.com',
    path: '/chat/completions',
    model: 'deepseek-chat',
    getKey: () => process.env.DEEPSEEK_KEY,
    provider: 'deepseek',
  },
};

module.exports = { API_ROUTES };
