# API 契约

协议版本 1。以下是 M0A 冻结的 M1 契约；只有 `docs/VERIFICATION.md` 标为已运行的接口才算实现证据。M2 Ask、结构化 brief、来源同步和新版归档暂不实现，不以 Mock 声称可用。

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
| GET /api/v1/watch/me | 身份/默认与允许空间、到期、capabilities={capture:true,ask:false,feed:true} |
| POST /api/v1/watch/captures | Bearer + Idempotency-Key(UUID)，body={workspace_id,text,created_at_client} |
| GET /api/v1/watch/feed | 授权空间内轻量 Capture，默认20最多50，稳定游标；不返回原文 |

Capture 首次201，重放200，均返回 `{schema_version:"1",capture_id,workspace_id,status:"saved",index_status:"pending",accepted_at}`，不依赖模型/ThinkFlow/索引成功。`owner_id + operation + client_request_id` 唯一；canonical hash 固定字段顺序 workspace_id/text/created_at_client，同键不同正文、空间或时间409 IDEMPOTENCY_CONFLICT。重新配对不改变 owner 级幂等性。

所有读取/重放都检查当前凭据有效期、撤销、scope和空间权限。feed 为 `{schema_version:"1", items:[{id,type:"capture",workspace_id,title,status:"saved",index_status,accepted_at}],next_cursor}`。标题确定性截取原文，不调用模型；没有 Ask 或 brief 时不伪造结果。

## 管理接口

`/api/v1/owner` 独立使用管理员 cookie，会话 HttpOnly、SameSite=Strict，服务器模式 Secure。写操作另需允许的 Origin 与 X-CSRF-Token；设备 Bearer 不取得管理权限。

M1 路径：POST /login、GET /session、POST /logout、GET/POST /workspaces、GET /devices、POST /devices/{id}/revoke、POST /pairings/lookup、POST /pairings/{id}/approve 或 /deny、GET /captures。批准 body 指定 allowed_workspace_ids 与 default_workspace_id，不能由 Watch 自授予。完整 Capture 仅管理端可见。

本机兼容 API `/api/state`、`/api/export`、`/api/settings`、`/api/tasks`、`/api/thinkflow/*` 在服务器模式不注册；设备 token 不能访问这些数据。服务器模式需要显式 HTTPS origin、管理员初始化、SQLite 与受信代理配置，不能仅改为0.0.0.0。

## 待实现

`POST /api/v1/watch/asks`、jobs/brief、中文资料同步、结构化回答、结果修订和新归档协议属于 M2/M3。设备能力明确禁用这些入口，旧网页任务接口保留自己的行为。普通读列表不能调用生成模型。
