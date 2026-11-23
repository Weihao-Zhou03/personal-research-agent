# API 契约

协议版本 1。Capture 保持 M0A 契约；本轮加入中文资料检索、持久 Ask、结构化简报、修订确认与可核对写回。实现与验证边界分别记录在 PR #1 和 `docs/VERIFICATION.md`。

## 通用约定

生产使用 HTTPS。时间为 UTC ISO 8601，设备传来的原始时间只作记录，排序使用 accepted_at。Capture 原文不 trim、不做 Unicode 归一化，只以 trim 判空；最多 4,000 Unicode code point，整个请求最多 32 KiB UTF-8。未知字段拒绝，HTTP body 必须是 JSON object。

错误为 `{ "error": { "code": "...", "message": "...", "retryable": false, "request_id": "req_..." } }`。区分 400/401/403/404/409/413/415/422/429/503；限流附 Retry-After。错误、日志和导出不含凭据或上游原始 body。

## 诊断与配对

| 路径 | 认证 | 行为 |
| --- | --- | --- |
| GET /api/v1/diagnostics | 无 | 仅 schema_version、version、request_id；用于 M0B 真实联网检查 |
| POST /api/v1/pairings | 无，限速 | pairing_request_id(UUID)、device_secret_hash(64位小写hex)、device_name(1–80 code point) |
| GET /api/v1/pairings/{id} | Bearer device_secret | 仅能读取自己的状态 |

Watch 首先把随机32字节生成的 base64url secret 和请求 UUID 保存在 Keychain，再发送 **SHA256(UTF8(device_secret))**。服务器仅保存 hash；短码可以在有效期内保存以支持首响应丢失重放。

配对响应：`{schema_version:"1", pairing_id, status, user_code, expires_at, approval_url}`。有效期10分钟，短码8位；到期不复活。相同 pairing_request_id/相同内容复用同一请求及短码；不同内容409。已批准时增加 owner_id、deployment_id、device_id、default_workspace:{id,name}、allowed_workspaces:[{id,name}]、device_expires_at。批准后重放不能改变权限。批准凭据默认90天有效，可由 owner 撤销。

共享向量见 `test/fixtures/watch-contract.json`：bytes 00..1f → `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` → `ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0`。这些是公开测试值，绝不能用于真实配对。

## 设备接口

| 路径 | M1 行为 |
| --- | --- |
| GET /api/v1/watch/me | 身份/默认与允许空间、到期、capabilities；Ask 同时取决于设备 scope 与模型配置 |
| POST /api/v1/watch/captures | Bearer + Idempotency-Key(UUID)，body={workspace_id,text,created_at_client} |
| GET /api/v1/watch/feed | 授权空间内轻量 Capture/Ask，默认20最多50，稳定游标；不返回原文或调用模型 |

Capture 首次201，重放200，均返回 `{schema_version:"1",capture_id,workspace_id,status:"saved",index_status:"pending",accepted_at}`，不依赖模型/ThinkFlow/索引成功。`owner_id + operation + client_request_id` 唯一；canonical hash 固定字段顺序 workspace_id/text/created_at_client，同键不同正文、空间或时间409 IDEMPOTENCY_CONFLICT。重新配对不改变 owner 级幂等性。

所有读取/重放都检查当前凭据有效期、撤销、scope和空间权限。feed 为 `{schema_version:"1", items:[{id,type,workspace_id,title,status,index_status,accepted_at}],next_cursor}`。标题确定性截取原文或问题。授权空间在 LIMIT 前过滤；游标绑定当前 owner/device/允许空间，权限变化后的旧游标拒绝。

## 管理接口

`/api/v1/owner` 独立使用管理员 cookie，会话 HttpOnly、SameSite=Strict，服务器模式 Secure。写操作另需允许的 Origin 与 X-CSRF-Token；设备 Bearer 不取得管理权限。

M1 路径：POST /login、GET /session、POST /logout、GET/POST /workspaces、GET /devices、POST /devices/{id}/revoke、POST /pairings/lookup、POST /pairings/{id}/approve 或 /deny、GET /captures。批准 body 指定 allowed_workspace_ids 与 default_workspace_id，不能由 Watch 自授予。完整 Capture 仅管理端可见。

本机兼容 API `/api/state`、`/api/export`、`/api/settings`、`/api/tasks`、`/api/thinkflow/*` 在服务器模式不注册；设备 token 不能访问这些数据。服务器模式需要显式 HTTPS origin、管理员初始化、SQLite 与受信代理配置，不能仅改为0.0.0.0。

## Ask 与只读简报

| 路径 | 行为 |
| --- | --- |
| POST /api/v1/watch/asks | Bearer、ask scope、Idempotency-Key UUID；body={workspace_id,question,created_at_client}；问题最多1000码点 |
| GET /api/v1/watch/jobs/{job_id} | 仅允许空间内状态/阶段、错误、更新时间和brief_ready，不返回长证据 |
| GET /api/v1/watch/jobs/{job_id}/brief | 未就绪202；就绪200，含结构化短简报、answer_status、修订、来源数、引用身份和更新时间，不返回正文引文 |

首次 Ask 202、同键重放200；响应 `{schema_version:"1",job_id,status,workspace_id,corpus_revision_id,accepted_at,poll_after_seconds:5}`。先提交持久事务，再由后台执行。与 Capture 分开使用 owner+operation+UUID 幂等空间；同键不同问题/时间/空间409，删除后保留 tombstone。正文、冻结语料、非秘密模型版本、提示词版本、调用预算与实际入选证据不可因重新配对或配置变化而改投。

任务状态为 queued/running/waiting_retry/completed/failed/cancelled/needs_attention。60秒租约、10秒心跳、owner/version fencing；启动恢复 queued。已发请求而结果未知时 needs_attention，不盲重发；明确429持久保存 Retry-After；格式修复和明确失败重试共用最多2次总调用。取消先持久化，再 Abort，晚到结果不能覆盖。每题保守输入上限8000 token（UTF-8字节上界+framing）、输出2500、单次90秒、串行执行，默认每日50个新问题。额度和已发调用的非敏感ledger不随任务删除清空；未知usage明确为unknown。

模型未配置时 Ask 503，Capture仍可保存。没有证据的任务正常 completed/insufficient_evidence，生成调用0次。`answered` 的每条Watch结论和任何状态的fact/inference都要求有效证据ID；不足/澄清可以是空引用的缺口提示。结构校验不证明语义支持度。引用标题、快照、原文、hash和位置由服务器生成。精确schema、长度与初始预算见设计§8，公开契约样例见 `test/fixtures/watch-ask-contract.json`。

## 管理端研究接口

以下路径均位于 `/api/v1/owner`，沿用 cookie、Origin/CSRF 保护。写入JSON上限512KiB，设备保持32KiB。

| 路径 | 行为 |
| --- | --- |
| GET/POST /workspaces/{id}；DELETE 同路径 | 读取/重命名/删除本地空间业务内容；删除不远程清除ThinkFlow或备份 |
| GET/POST /workspaces/{id}/sources | 来源列表与索引状态；导入{title,text,source_id?}，TXT/MD原文最多100000码点，原文不trim |
| POST /workspaces/{id}/bind；/sync | {notebook_id}绑定；{notebook_id,source_ids?}真实读取后原子发布语料，失败保留旧版本 |
| POST /workspaces/{id}/search | {question}只读检索当前冻结语料 |
| DELETE /sources/{id} | {workspace_id}，新语料排除，历史快照仍可核对 |
| GET /source-versions/{id} | 有权空间的完整不可变原始快照 |
| POST /captures/{id}/retry-index | 显式把失败索引重新排队；没有模型调用 |
| POST /workspaces/{id}/asks | {question,request_id,created_at_client,retry_of?}，新任务或幂等重放 |
| GET /jobs?workspace_id=&cursor=&limit= | 授权空间内分页任务；GET /jobs/{id} 包含报告、证据、修订、事件、调用记录和归档 |
| POST /jobs/{id}/cancel | {}持久取消；重做用新UUID并显式retry_of，可能产生新用量 |
| POST /jobs/{id}/result | {result_revision,expected_content_hash,result}，乐观校验后保存新不可变修订，冲突409 |
| POST /jobs/{id}/confirm | {result_revision,expected_content_hash,write_to_thinkflow:false/true}，固定确认内容及目标 |
| GET /jobs/{id}/archives | 本地人工归档与上游写回状态分别显示 |
| POST /writebacks/{intent_id}/reconcile | {}只读GET核对上游已有文档，绝不再次POST |
| DELETE /jobs/{id} | 删除本地私有任务、证据、报告与归档；保留必要幂等和计数 |
| POST /devices/{id}/settings | {allowed_workspace_ids,default_workspace_id,enable_ask}；只由管理员授予；不改变outbox原空间 |
| GET/POST /model | 非秘密版本配置；api_key只存进程内存，响应仅has_api_key |
| POST /model/connection-check；/generation-check | {}；前者只读模型列表，后者显式使用一个公开固定样本真实生成一次 |
| GET /usage；/readiness | 独立用量/未知状态；数据库写探针、worker心跳及Capture/Ask/ThinkFlow分别就绪 |
| POST /backup；GET /export | 私有目录一致性整库备份；普通业务JSON排除身份凭据，不含ThinkFlow原始文件 |
| GET /thinkflow/notebooks；/thinkflow/notebooks/{id}/sources | 真实上游清单，仅管理端可读 |

确认不是立即写回成功。本地归档后以独立意图执行，标记 `personal_agent_writeback_intent_id`；同修订同意图，新修订新文档。POST前持久标记已发，丢响应后读取上游清单和真实正文核对目标/修订/hash；唯一匹配才verified。未找到、多份或内容冲突转人工处理，已经发过的意图不再自动POST。租约不是跨系统exactly-once。

旧研究工作台继续原有来源hash、任务队列及保守中断恢复行为；旧 `personal_agent_task_id` 只用于原兼容路径。新来源保存原文快照，ThinkFlow导入本身会去首尾空白，因此以实际读回正文为准。
