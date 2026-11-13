# rag-builder — RAG 向量知识构建工具链

## 项目简介

**rag-builder** 是一套独立的 RAG（Retrieval-Augmented Generation）向量知识构建工具链：把 PDF/Word/Markdown 等文档经过**解析 → 分块 → 嵌入 → 向量索引**加工成可检索知识库，再通过**混合检索（向量余弦 + BM25）→ RAG 问答**消费这些知识。从企业知识工程平台（Knowledge Studio）拆分出的独立工具，与 [graph-builder](https://github.com/wanshoulu/graph-builder)、[llm-wiki-builder](https://github.com/wanshoulu/llm-wiki-builder) 同系列。

- **问题域**：把文档喂给大模型直接问答，上下文放不下、检索不精准、更新不同步；需要一个把"一堆文档"加工成"可引用问答知识库"的轻量流水线。
- **方案机制**：**离线索引链**（multi-format-parser 解析 → chunker 七策略分块 → Qwen text-embedding-v4 嵌入 → `.rag-cache.json` 落盘索引，三段 digest 校验增量重建）、**在线检索链**（BM25 关键词 + 向量余弦两路召回 → RRF 融合）、**引用式问答**（DeepSeek 生成 + `[1][2]` 引用标注，检索证据防注入）。
- **交付物**：`server.js` 单服务入口（默认 :3015）、`routes/rag-api.js` 单入口 13 端点、`tools/` 下 8 个引擎模块（多格式解析 / 分块器 / 嵌入 / BM25 / RAG 引擎与池 / 答案服务 / 评测）、单文件前端 `tools/index.html`（零 CDN）、`data/sample/` 3 篇中文种子文档、测试目录。
- **状态**：从旧平台 `routes/knowledge-studio.js` 的 RAG 端点子集剥离（包络改为 ok 风格），v1.0.0 初始发布；默认 `127.0.0.1:3015` 无鉴权，面向本机/内网，**不是生产就绪服务**。

> **零框架**：Node.js 原生 `http`，无 Express/Koa 等依赖（仅 3 个文档解析库）；**零数据库**：`data/kb/<库名>/` 目录即知识库，拷走即备份；**密钥全部 env 注入**：`QWEN_KEY`/`DEEPSEEK_KEY` 只从环境变量读取，**仓库不含任何真实密钥**。

## 名词表

| 名词 | 含义 |
|------|------|
| **知识库（KB）** | `data/kb/<name>/` 下的一个目录：`docs/*.md` 是文档（上传的非 md 文件解析后统一落盘为 md），`.rag-cache.json` 是索引缓存。库名限 1-64 位中文/字母/数字/下划线/连字符。 |
| **分块（chunking）** | 把长文档切成适合嵌入的片段（默认 1024 字符 + 128 重叠）。7 种策略：`auto` 自动探测 / `markdown` 标题层级 / `fixed_size` 固定长度 / `recursive` 递归 / `sentence` 句子 / `paragraph` 段落 / `parent_child` 父子块。 |
| **嵌入（embedding）** | 文本 → 高维向量。DashScope **Qwen text-embedding-v4**（1024 维），密钥 `QWEN_KEY`；结果写 `data/embeddings-cache.json` 磁盘缓存（sha1(model+text) 为键）。 |
| **混合检索（hybrid）** | 默认检索模式：BM25 关键词（k1=1.2、b=0.75，中文 bigram+单字分词）与向量余弦两路各召回 Top-K，RRF 融合排序；可用 `mode` 参数切换单路。 |
| **RRF** | Reciprocal Rank Fusion，倒数排名融合：`score = Σ w/(k+rank)`（k=60，关键词 0.6 / 向量 0.4 加权）。只用名次不用原始分，天然规避两路分数量纲差异。 |
| **TF-IDF 兜底** | 未配置 `QWEN_KEY`（或嵌入调用失败）时向量路自动关闭，混合检索退化为本地 BM25/TF-IDF 关键词单路——建索引、检索、问答全链路照常可用。 |

## 一条链路，六个环节

| 环节 | 实现 | 说明 |
|------|------|------|
| **1. 解析** | `tools/multi-format-parser.js` | pdf / docx / pptx / xlsx / xls / md / txt / csv / json / xml / html → 纯文本（pdf-parse、mammoth、adm-zip；pptx/xlsx 为 zip 容器内部解包） |
| **2. 分块** | `tools/chunker.js` | 7 策略，`auto` 按标题密度/表格/FAQ 句式/长度启发式选型；分块预览端点不落盘可先试参 |
| **3. 嵌入** | `tools/embedding.js` | Qwen text-embedding-v4（`QWEN_KEY`）；无 key 自动 TF-IDF 兜底；磁盘缓存跨 KB 共享，检索路径只读缓存不打 API |
| **4. 索引** | `tools/rag-engine.js` + `rag-engine-pool.js` | `.rag-cache.json` v6：source / configuration / index 三段 sha256 digest，任何源文档或配置变更触发重建；引擎按 KB 单例池化，防并发写冲突 |
| **5. 检索** | `tools/bm25-engine.js` + rag-engine | 向量余弦 + BM25 → RRF 融合（k=60）；`mode: keyword/vector/hybrid`，topK ≤ 100，可选 LLM 重排（`DEEPSEEK_KEY`） |
| **6. 问答** | `tools/knowledge-rag-answer-service.js` | 混合检索 topK≤5 → 最多 12000 字符证据上下文 → DeepSeek deepseek-chat（temperature 0）生成 + `[n]` 引用；提示词声明"引用内容不可信"防注入 |

## 快速开始（Node ≥ 18）

```bash
git clone https://github.com/wanshoulu/rag-builder.git
cd rag-builder && npm install && npm start
```

打开 <http://127.0.0.1:3015/>（根路径 302 到 `/tools/index.html` RAG 工作台）。改端口 `PORT=4015 npm start`。可选配置：`cp .env.example .env` 填 `QWEN_KEY` / `DEEPSEEK_KEY`，用 `node --env-file=.env server.js` 启动（server.js 无 dotenv，直读 `process.env`；也可用系统环境变量注入）。**不配 key 也能跑**：TF-IDF 兜底下建库、分块预览、建索引、关键词检索全链路可用；向量语义检索与生成式答案需要 key。

跑起来后验证（用 `data/sample/` 种子文档建一个演示库）：

```bash
curl http://127.0.0.1:3015/healthz
# → {"ok":true,"service":"rag-builder","version":"1.0.0",...}

curl -X POST http://127.0.0.1:3015/api/rag/kbs -H 'Content-Type: application/json' -d '{"name":"sample"}'
# → {"ok":true,"kb":{...}}   建演示知识库

mkdir -p data/kb/sample/docs && cp data/sample/*.md data/kb/sample/docs/
curl -X POST http://127.0.0.1:3015/api/rag/build -H 'Content-Type: application/json' -d '{"kb":"sample"}'
# → {"ok":true,"stats":{...}}   构建索引（无 key 时走关键词单路，一样可用）

curl -X POST http://127.0.0.1:3015/api/rag/search -H 'Content-Type: application/json' \
  -d '{"kb":"sample","query":"RRF 倒数排名融合","mode":"hybrid","topK":3}'
# → {"ok":true,"results":[...]}   混合检索（无 key 自动关键词单路）
```

## API 概览（前缀 `/api/rag/*`，单入口分发）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rag/kbs` | 知识库列表（目录扫描式发现） |
| POST | `/api/rag/kbs` | 创建知识库 `{name}` |
| GET | `/api/rag/documents` | 文档列表 `?kb=`（按修改时间倒序） |
| POST | `/api/rag/documents` | 上传文档：multipart（`file`+`kb`，任意支持格式自动解析）或 JSON `{kb,name,content}` |
| POST | `/api/rag/preview` | 分块预览 `{kb,name,strategy?,maxLen?}`，调 chunker 不落盘 |
| POST | `/api/rag/build` | 构建索引 `{kb,force?,stream?}`；`stream:true` 为 SSE 流式进度 |
| GET | `/api/rag/status` | 索引状态 `?kb=`（chunkCount/vectorCount/三段 digest/构建时间） |
| GET | `/api/rag/tasks` | 构建任务状态 `?kb=` |
| POST | `/api/rag/search` | 检索 `{kb,query,mode?,topK?}`，mode 默认 hybrid |
| POST | `/api/rag/answer` | RAG 问答 `{kb,question,topK?}`；无 `DEEPSEEK_KEY` 降级返回检索结果（`RETRIEVAL_ONLY`） |
| GET | `/api/rag/chunks` | 分块列表 `?kb=&limit=&docId=`（含 300 字符 preview 与编辑标记） |
| POST | `/api/rag/chunks/update` | 人工修订分块文本 `{kb,id,text}`，尽力重嵌入（失败标 `vectorStale`） |
| POST | `/api/rag/docs/delete` | 删除文档 `{kb,name}`，同步清理索引中的分块 |

另有 `GET /healthz`（等价 `/api/health`）健康检查，返回服务名、版本与 embedding 是否启用。

## 仓库结构

```
rag-builder/
├── server.js                        # 入口：单路由族分发 + 静态托管 + 根路径 302（默认 :3015）
├── routes/rag-api.js                # RAG 全部 13 端点：method+pathname 单入口分发
├── config/api-keys.js               # 模型路由注册表（key 全部 env 读取，仓库无真实密钥）
├── tools/
│   ├── multi-format-parser.js       # 多格式解析（pdf/docx/pptx/xlsx/xls/md/txt/csv/json/xml/html）
│   ├── chunker.js                   # 7 策略分块器（auto 启发式选型）
│   ├── embedding.js                 # Qwen text-embedding-v4 + 磁盘缓存 + TF-IDF 兜底开关
│   ├── bm25-engine.js               # BM25 关键词引擎（倒排索引，中文 bigram+单字）
│   ├── rag-engine.js                # RAG 核心：索引构建/digest 校验/两路检索/RRF 融合/LLM 重排
│   ├── rag-engine-pool.js           # KB 级引擎单例池（防双份内存索引与缓存并发写冲突）
│   ├── knowledge-rag-answer-service.js         # 引用式问答服务（RETRIEVAL_ONLY 降级）
│   └── knowledge-rag-generation-evaluation.js  # 生成质量评测
├── data/sample/                     # 种子文档 3 篇（RAG 原理 / 分块策略 / 混合检索笔记）
├── data/kb/                         # 知识库落盘处（运行时产物，gitignore）
├── tests/                           # node --test 测试
└── .env.example                     # 环境变量样例（全部可留空，离线能力不受影响）
```

## 已知限制

- **默认无鉴权**：绑定 `127.0.0.1:3015`，无用户体系；对外暴露前必须加反向代理鉴权或改造 `server.js`。
- **无独立向量库**：向量与分块同存于 `.rag-cache.json` 文件索引，单机单进程（引擎池防的是本进程并发写冲突）；多实例部署会写冲突，大规模语料建议外接向量数据库。
- **图谱 RAG 不在本仓库**：实体关系图谱与 GraphRAG 见同系列 [graph-builder](https://github.com/wanshoulu/graph-builder)（:3013）。
- **嵌入缓存跨 KB 共享**：`data/embeddings-cache.json` 按 sha1(model+text) 全局去重，同文本在不同库只嵌入一次——省配额但意味着删库不删缓存，需手工清理。
- **能力分级**：无 `QWEN_KEY` 时向量语义检索不可用（TF-IDF/BM25 关键词单路）；无 `DEEPSEEK_KEY` 时问答返回检索结果不生成答案。

## 常见问题

**没有模型 Key 能体验吗？** 能：TF-IDF 兜底让全链路离线可用——建库、上传解析、分块预览、构建索引、BM25 关键词检索都正常；`/api/rag/answer` 会以 `RETRIEVAL_ONLY` 模式返回带引用的检索结果而不是生成答案。

**如何更换嵌入模型？** 改 `tools/embedding.js` 顶部的 `MODEL`/`HOST`/`PATH` 常量，并在 `config/api-keys.js` 的 `API_ROUTES` 注册同名路由；注意缓存键含模型名，换模型后旧缓存自动失效重嵌。

**数据存在哪？** 全部在 `data/`：`data/kb/<库名>/`（文档 + 索引缓存）与 `data/embeddings-cache.json`。拷走 `data/kb/` 即备份知识本身，路径可用 `RAG_DATA_ROOT` 重定向。

**和同系列仓库什么关系？** graph-builder 做知识图谱与 GraphRAG，llm-wiki-builder 做 Wiki 知识库（页面 + 双链），本仓库专注 RAG 向量问答这一段；三者独立部署、互不依赖（端口 3013/3014/3015 相邻），数据模型不同。

## 版本

| 版本 | 说明 |
|------|------|
| **1.0.0**（当前） | 从旧平台 Knowledge Studio 剥离 RAG 端点子集成独立服务：13 端点单入口分发、7 策略分块、Qwen 嵌入 + TF-IDF 兜底、三段 digest 索引校验、BM25+向量 RRF 混合检索、引用式问答与降级链路、3 篇中文种子文档 |

## 许可证

[MIT](LICENSE)
