# ThinkFlow 接入说明

本项目现已接入 [OpenDCAI/ThinkFlow](https://github.com/OpenDCAI/ThinkFlow)。你可以在工作台读取 ThinkFlow 笔记本中的资料，交给当前选择的模型处理，审阅并修改结果，最后确认保存为同一笔记本中的原生文档。本地知识库保留确认记录，ThinkFlow 承载原始资料与正式成果。

这次以本机完整流程为目标。任务队列与模型调用仍由现有 Personal Agent 负责，ThinkFlow 负责资料及文档；并未把整个任务执行器替换为 ThinkFlow Agent。

## 打开和使用

双击项目根目录 `start.cmd`。

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| Personal Agent | http://127.0.0.1:4317 | 选择资料、发起任务、审阅、确认与查看结果 |
| ThinkFlow 原生界面 | http://127.0.0.1:8437 | 浏览笔记本、原始素材与文档工作台 |
| 本机模型代理 | http://127.0.0.1:8317/v1 | 复用已有授权调用 `gpt-6-luna` |

1. 工作台点击“选取资料”。选择笔记本；没有资料时展开“新建笔记本或添加文字资料”，创建笔记本后填入标题和正文，点击“保存资料到 ThinkFlow”。这一步保存原始材料。
2. 勾选材料，点击“读取预览”。看到实际正文后，点击“使用已读取资料”。资料栏会锁定为该来源快照；要自行改正文，可点“改为手动材料”，此后生成结果仅进入本地库。
3. 填写主题、任务类型、目标，预览并确认后开始处理。读取资料、创建草稿和模型生成都不会自动写回结果。
4. 在“我的任务”对照来源审阅，必要时编辑或追问。选用云端时，正文与任务会发送给已配置的模型服务。
5. 点击“确认并写回 ThinkFlow”。程序先登记这次确认，再创建原生 `summary_doc`，用 GET 重新读取正文核对。核对成功后，本地知识库才显示完成。
6. 点击“读取 ThinkFlow 文档”可查看从 ThinkFlow 实时读到的正文；“打开 ThinkFlow”进入原生页面，打开相应笔记本，点击右侧文档标题即可展开全文。

ThinkFlow 原生素材上的“待入库”指尚未建立向量索引。本次通过正文接口直接读取，因此没有向量索引也可完成上述流程。它与“资料没有保存”是不同的状态。

## 核查了哪个版本

部署固定在提交 [`1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3`](https://github.com/OpenDCAI/ThinkFlow/tree/1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3)，不会在启动时自动拉取最新代码。原版包含 FastAPI 后端和 React/Vite 前端，当前导入后登记了 123 条路由。包装入口只增加本机访问限制、健康检查和静态 UI 挂载，没有修改上游源码。

接口主要由 [kb_notebooks.py](https://github.com/OpenDCAI/ThinkFlow/blob/1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3/fastapi_app/routers/kb_notebooks.py)、[kb_sources.py](https://github.com/OpenDCAI/ThinkFlow/blob/1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3/fastapi_app/routers/kb_sources.py)、[kb_documents.py](https://github.com/OpenDCAI/ThinkFlow/blob/1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3/fastapi_app/routers/kb_documents.py) 及其调用的 service 实现。Python 依赖固定在 `scripts/thinkflow-requirements.lock`；前端使用上游的 package-lock 和 `npm ci`。当前是 Python 3.11 的 Windows 部署，尚未验证 ARM 树莓派运行。

| 上游现有能力 | 本次核查与接入情况 |
| --- | --- |
| 笔记本管理与资料清单 | 已实际创建笔记本、保存文字资料并读取清单 |
| 资料正文读取 | 已实际读取两份 Markdown 原文；适配器允许 txt、md、markdown、有文本层的 PDF，PDF 尚未单独实测 |
| 原生文档读写 | 已创建 `summary_doc`、读取全文，原生 UI 可打开；保留任务、来源与内容校验信息 |
| 文档版本、焦点和暂存操作 | 上游有接口，本次未扩展到应用 UI；回写创建新文档，不覆盖已有成果 |
| 通用资料向量检索 | 上游有切块、embedding 与 FAISS 代码；本机没有部署其 embedding 服务，本次未启用 |
| BM25 与向量混合检索 | 上游另有混合检索代码，针对数据源表结构等 SQL 场景，不能据此宣称已实现本项目的文档 BM25 融合重排 |
| 报告、PPT、视频等产出 | 原生界面包含入口，依赖相应模型及工具；未作为本次接入的已验证能力 |
| Skills 与 Plan-and-Execute | 没有接入本项目的 Skills 加载器、工具权限或可恢复的多步骤调研编排 |

文档检索的代码依据是 [vector_store_tool.py](https://github.com/OpenDCAI/ThinkFlow/blob/1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3/workflow_engine/toolkits/ragtool/vector_store_tool.py)；SQL 场景的混合检索位于 [hybrid_retriever.py](https://github.com/OpenDCAI/ThinkFlow/blob/1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3/fastapi_app/modules/rag/hybrid_retriever.py)。这些是对代码现状的核查，不是本机 RAG 运行结果。

## 实际调用的接口

上游根地址 `http://127.0.0.1:8437`，本地身份使用 `user_id=local` 和 `email=local`。适配器只连接本机 HTTP 根地址；浏览器不接触用户模型密钥。

| 目的 | ThinkFlow 原生接口 |
| --- | --- |
| 列出或创建笔记本 | `GET /api/v1/kb/notebooks`、`POST /api/v1/kb/notebooks` |
| 笔记本资料清单 | `GET /api/v1/kb/files` |
| 保存文字原始资料 | `POST /api/v1/kb/add-text-source` |
| 读取选定资料正文 | `POST /api/v1/kb/get-source-display-content` |
| 列出或创建成果文档 | `GET /api/v1/kb/documents`、`POST /api/v1/kb/documents` |
| 读回成果全文 | `GET /api/v1/kb/documents/{document_id}` |

应用在 4317 提供 `/api/thinkflow/notebooks`、`/api/thinkflow/notebooks/{id}/sources`、`/api/thinkflow/read` 等同源适配接口。创建任务时提交 `thinkflow.notebookId`、`sourceIds` 与预览哈希；服务端重新列出资料并读取正文，不接受客户端传入任意文件路径或冒充的 ThinkFlow 正文。来源不属于笔记本、已变化、无正文或超出限制时明确报错。

## 来源与确认如何保留

任务保存读取时的原文、资料 ID、笔记本 ID、原生路径、TF 编号、句段范围、读取时间及 SHA-256。正文中按顺序分配“材料 n”编号；结果附录登记每份资料及校验值。新写回文档的 metadata 同时保存来源引用和当时的原文快照，用于原始文件以后发生变化时回查。本次早期联调文档可能没有后来加入的快照字段。

SHA-256 用来判断两次内容是否相同，不证明模型结论正确。模型也可能给出不准确的引用或建议，因此结果仍需审阅。

首次确认时先持久化已确认内容，再调用 ThinkFlow。每个任务使用持久化任务 ID 作为文档标记；重试先查找这个标记，校验内容哈希并读回正文。重复点击会返回同一确认记录；同一进程内同时确认会被互斥控制。多个独立 Personal Agent 进程并发写同一数据目录不受支持。

如果 ThinkFlow 已保存文档，但响应丢失，本地不会提前记成功。重启后重新点击“重试核对并写回”，会找到原文档并核对恢复。发起确认后内容会锁定，防止重试时另建不同稿件。若文档被外部修改或出现多份任务标记，程序报冲突并保留现场，不自动覆盖或删除。

## 安装与存储

当前电脑已安装。新环境执行：

```powershell
powershell.exe -NoProfile -File .\scripts\setup-thinkflow.ps1
powershell.exe -NoProfile -File .\scripts\start.ps1 -NoBrowser
```

安装需要 Git、uv、Node.js/npm 和可用网络，使用用户级 Python 3.11 环境。安装脚本不会更改系统 Python，也不会自动安装 embedding、OCR、ASR 或其他大模型服务。已存在但版本不同或已修改的上游检出不会被重置。

| 路径 | 内容 |
| --- | --- |
| `.runtime/thinkflow/source` | 固定版本的上游源码和构建前端 |
| `.runtime/thinkflow/venv` | ThinkFlow 专用 Python 环境 |
| `scripts/run-thinkflow.py` | 本机包装入口，监听 127.0.0.1:8437 |
| `data/thinkflow/outputs` | 原始资料、文档及其版本的真实存储目录 |
| `.runtime/thinkflow/source/outputs` | 指向上述目录的 Windows 目录联接 |
| `data/workspace.json` | 任务、原文快照、对话、确认意图及本地确认记录 |
| `.runtime/thinkflow.stderr.log` | 上游运行日志 |

备份时先停止服务，再复制整个 `data` 目录。网页 JSON 导出只覆盖应用业务记录，不包含 ThinkFlow 原生文件。不要单独移动或删除 outputs 目录联接；在另一台电脑恢复时，先恢复 `data`，再运行安装脚本重建联接。

原生 API 使用上游公开客户端内置的接口标识，本地模式并非多用户权限系统。包装器限制本机 Host 和浏览器 Origin，服务仅监听回环地址。不要把 4317 或 8437 直接暴露到公网。模型客户端密钥只从已授权的现有代理配置读取到内存，不复制 OAuth 文件，也不进入构建产物。

## 验证证据与剩余范围

2026 年 10 月 20 日，真实浏览器完成了：创建笔记本 → 保存两份标注为联调示例的资料 → 读取 426 字符正文 → 预览确认 → gpt-6-luna 整理 → 编辑 → 确认写回 → 原生 ThinkFlow 展开成果全文。确认前该笔记本结果文档为 0，首次确认后为 1，重复确认仍为 1，读回与审阅稿逐字一致。

随后又用新增的来源句段范围与原文快照跑通第二项真实任务，验证 metadata 中的快照与任务原文一致，重复确认仍只有一份该任务的文档。笔记本目前保留两份分别对应两项示例任务的成果。

具体任务、文档 ID 与校验值见 [thinkflow-verification.json](thinkflow-verification.json)。界面验证图为 [资料预览](thinkflow-source-preview.png) 和 [写回结果](thinkflow-writeback.png)。当前 30 项自动测试全部通过，其中 6 项覆盖适配器与确认回写的关键流程，包括资料成员校验、预览过期、并发确认、读回不一致、响应丢失和重启恢复。

本轮没有验证真实语音、摄像头、树莓派速度、图片或音视频解析，也没有启用文档 RAG、嵌入模型或完整调研 Agent。下一步若做 RAG，应先确定 embedding 服务和资料规模，再验证召回、重排、引用准确率与版本过滤。

## 常见问题

- 连接不到 ThinkFlow：运行 `start.cmd`，检查 `.runtime/thinkflow.stderr.log`。若端口被其他程序占用，启动器不会结束未知进程。
- 资料清单为空：确认选对笔记本，先保存原始资料，再刷新清单。原生“待入库”不影响本次直接读正文。
- 预览后无法创建任务：资料可能已改变，重新读取预览。一次最多选 20 份，正文含标记最多 100,000 字符，不自动截断；本地 Ollama 仍有更小的上下文预算。
- 回写失败：恢复服务后重试同一任务，程序会先核对已有文档；不要另建任务来代替重试。
- 提示内容冲突：在 ThinkFlow 查看该任务已有文档与任务记录，核对外部修改，不要靠重复点击覆盖。
- 原生对话或“重新入库”失败：这些属于 ThinkFlow 自己的模型和 embedding 链路。本次已验证的任务入口是 4317；未配置的原生能力不代表接入流程失效。
