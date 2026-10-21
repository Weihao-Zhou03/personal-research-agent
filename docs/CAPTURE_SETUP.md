# Capture、资料问答与恢复

这是独立于旧研究任务的SQLite链路。当前代码提供管理员登录、空间、配对、原文Capture、中文索引、持久Ask、结构化简报、审阅与确认写回。Capture原文与索引意图同事务保存，后台每秒消费queued索引；失败保留原文并由管理员明确重试，不调用模型或ThinkFlow。真机、签名安装与常开公网部署仍未完成，实际验证入口见 [VERIFICATION.md](VERIFICATION.md)。

## 在 Windows 隔离试用

使用 Node **24.19.0**；无需 npm install。保持原有 4317 服务与 `data` 原样，在新 PowerShell 窗口运行：

```powershell
node --version
$captureData = Join-Path $env:LOCALAPPDATA 'PersonalResearchAgent\capture-dev'
node scripts/init-owner.mjs --data-dir $captureData
$env:PERSONAL_AGENT_DATA_DIR = $captureData
$env:PERSONAL_AGENT_STORAGE = 'sqlite'
$env:PERSONAL_AGENT_MODE = 'local'
$env:PERSONAL_AGENT_PORT = '4319'
node server.mjs
```

初始化命令在终端隐藏输入至少12字符的管理员密码，只保存 scrypt 校验值。不要将密码写入命令参数、仓库、截图或聊天。重复初始化会拒绝修改已有密码；目前没有 Web 密码重置入口。自动化可以明确选择 `--password-stdin`，秘密由调用环境提供，不能把实际密码写进脚本。

打开 `http://127.0.0.1:4319/owner`。登录后创建空间，输入Watch显示的8位配对码，核对设备名和时间，选择允许空间与默认空间后批准。新配对范围包含Capture、Ask及所选空间的feed读取；未配置可用模型时capabilities.ask为false。旧M1已配对设备可能没有ask范围，需要在管理页明确开启。页面能拒绝配对、撤销设备和调整设备空间。最近列表显示原文与实际索引状态，索引失败可“重试索引”；`待索引`不表示已可检索。设备feed只含标题与状态，问答详情通过相应设备权限接口读取。

## 电脑上先跑资料→问题→确认写回

1. 在管理页“研究资料与问答”选择空间，上传TXT/MD或粘贴原文，检查预览后保存。每份最多100,000个码点；正文空格和换行原样保留，不抓取任意URL，也不把AI回答自动转成原始资料。
2. 或读取ThinkFlow笔记本和完整来源列表，勾选实际资料后同步。每份正文分别记录读取时间；全部准备完成才发布新语料。列表或任一正文失败保留最近成功快照。上游自身导入文本会去掉首尾空白，本项目快照保留上游实际已存正文，不承诺恢复上游已删字节。
3. 填写云端兼容API地址、模型名（例如已有代理的`gpt-6-luna`）和服务密钥，再保存。连接检查只读模型列表；“真实生成检查”明确触发一次公开样本生成，会消耗模型额度。Linux远程后端不能假定Windows的127.0.0.1代理在同机可达。
4. 在同一空间提出问题，后端持久接收后可关闭页面，稍后打开任务。中文检索只查有权空间和提交时冻结的语料，再生成结构化简报。没有足够证据时返回资料不足，不自动互联网搜索。逐项核对原文、位置、hash及限制，引用编号合法本身不能证明结论正确。
5. 在当前结果中审阅并保存新修订，再明确“确认归档到本地知识”或“确认归档并写回ThinkFlow”。写回前需把空间绑定到已核对笔记本。已确认内容与修订锁定，真实正文读回后才显示写回核对成功；重复确认同修订复用同一意图。新修订可创建新文档。
6. 结果未知或冲突时使用“只读核对已有写回”；不能用自动重发制造重复文档。删除本地任务/空间不承诺删除远端文档或已有备份。每日Ask限额和实际usage保留非敏感账本，删除内容不重置当天额度；usage缺失显示unknown，不能写0。

管理页支持取消未完成任务、查看真实阶段与用量、明确创建重做任务。重做使用新请求编号，可能产生新用量。单题最多2次生成调用，包含格式修复和重试；已发出请求而响应未知时进入待人工核对，不能把超时当成“免费失败”。

没有 Watch 时，`npm test` 用隔离数据库和真实 HTTP 验证相同接口；这是后端验证，不能替代真机断网、系统输入或 Keychain 验证。Watch 工程、构建命令和分发阻塞见 [APPLE_DELIVERY.md](APPLE_DELIVERY.md)。HTTP loopback 仅供电脑调试，Watch 的 127.0.0.1 指向手表自身，不能访问这台电脑。

关闭前台服务用 Ctrl+C。新窗口中的环境变量不影响原服务；再次运行同一目录会恢复已保存记录与设备身份。原来的 `start.cmd` 仍用于本机旧工作台，默认不启动 Ollama。

## 环境配置

| 名称 | 行为 |
| --- | --- |
| PERSONAL_AGENT_MODE | 默认 local；远程部署必须显式 server |
| PERSONAL_AGENT_STORAGE | 默认 json；Capture 必须 sqlite |
| PERSONAL_AGENT_DATA_DIR | 数据目录；默认仓库 data。试用必须指定隔离目录 |
| PERSONAL_AGENT_DATABASE | 可选数据库路径；默认数据目录/workspace.sqlite |
| PERSONAL_AGENT_PORT | HTTP 服务端口；默认4317 |
| PERSONAL_AGENT_PUBLIC_ORIGIN | server 必填，根 HTTPS origin，不含路径、凭据、query |
| PERSONAL_AGENT_TRUSTED_PROXIES | 显式可信 TLS 代理地址，逗号分隔；M1 只支持 loopback |
| PERSONAL_AGENT_LISTEN_HOST | 默认127.0.0.1；local 拒绝非 loopback |
| PERSONAL_AGENT_MODEL_BASE_URL | 新Ask的云端兼容API根地址；远程HTTPS，同机代理可HTTP |
| PERSONAL_AGENT_MODEL | 新Ask模型名称，例如gpt-6-luna |
| PERSONAL_AGENT_MODEL_KEY_FILE | 服务账户可读的私有密钥文件；不提交Git |
| PERSONAL_AGENT_MODEL_KEY | 未使用KEY_FILE时的私有环境密钥；仅匹配相同MODEL_BASE_URL |
| PERSONAL_AGENT_DAILY_ASK_LIMIT | 默认50，每日接收上限；当前按UTC日期记账 |
| PERSONAL_AGENT_BACKUP_DIR | 管理员手动备份使用的私有目录，默认不配置 |

管理页输入的模型key只保存在内存。希望重启后可用，应在调用进程的私有环境或密钥文件配置上述MODEL变量；不要把密钥贴在聊天、命令参数或公开示例中。原本的 `PERSONAL_AGENT_API_KEY` 属于旧工作台配置，不替代新Ask的MODEL_KEY。

初始化 CLI 使用 `<data-dir>/workspace.sqlite`；若选择自定义 DATABASE，应先在相同目录初始化并把该文件作为自定义路径，避免初始化与服务指向不同文件。CLI 不自动识别服务环境里的 DATABASE。

## 显式迁移旧 JSON

本轮没有切换现用数据。迁移会创建新库并备份原 JSON，需先准备具体路径、停止旧写入并按用户的数据操作授权执行。示例均为占位路径，不能直接替换生产库：

```powershell
node scripts/migrate-workspace.mjs --source 'D:\PrivateAgent\workspace.json' --database 'D:\PrivateAgent\workspace.sqlite' --backup-dir 'D:\PrivateBackups\before-capture'
node scripts/init-owner.mjs --data-dir 'D:\PrivateAgent'
```

迁移保留原 ID、原文、时间、编辑、追问、事件、来源快照、ThinkFlow 元数据、确认锁定和知识关联。先验证，再用事务导入并核对；源文件不改。相同来源重跑只核验，来源变化、非空业务库或导入后已编辑的数据均拒绝覆盖。启动 SQLite 时也会核对遗留 JSON 的原始 hash，防止继续由旧写入者改动后被悄悄接管。不要同时运行指向同一业务数据的旧/新服务。

迁移不会自动执行旧 queued/running 任务。旧工作台打开后仍将其标为失败，等待人工重跑。详见 [DATA_MIGRATION.md](DATA_MIGRATION.md)。

## 活跃库备份与新目录恢复

```powershell
node scripts/backup-workspace.mjs backup --database 'D:\PrivateAgent\workspace.sqlite' --backup-dir 'D:\PrivateBackups\capture'
node scripts/backup-workspace.mjs restore --backup 'D:\PrivateBackups\capture\实际备份文件.sqlite' --database 'D:\PrivateRestore\workspace.sqlite'
```

备份命令输出实际文件与 manifest 路径。恢复默认读取相邻 manifest，只允许新目标文件，核对 integrity、外键、数量、内容 hash 和旧知识关联。活跃 WAL 必须用此一致性备份，不单独复制主库。SQLite ≥3.51.3 是门槛；CI/本机实际为3.53.3。

数据库备份包含认证校验值，与 `/api/v1/owner/export` 新业务导出及旧 `/api/export` 不同，必须放在私有目录；原JSON原字节备份也可能带早期遗留字段。Windows上需自行设置目录ACL，Node文件mode不构成权限核验。ThinkFlow原始资料和模型凭据需另备。管理页“私有备份”要求预先配置PERSONAL_AGENT_BACKUP_DIR；恢复继续使用拒绝覆盖的新路径CLI。

自动日备命令为 `node scripts/backup-scheduled.mjs --database 绝对路径 --backup-dir 私有绝对目录 --retain 7`。只在新备份核验成功后清理本脚本自建且仍通过核验的旧备份对，不递归清目录、不删除未管理文件。Linux systemd每日调度、私有环境文件和保留策略见 [deploy/README.md](../deploy/README.md)；本机没有自动启用生产定时器。

回退前备份新 SQLite 和新增 Capture；旧 JSON 不包含新增记录，不能拿旧文件直接覆盖新库。

## 准备 HTTPS 后端

当前 `server.mjs` 提供 HTTP，由同机 TLS 反向代理终止 HTTPS；M1 不支持信任任意远端转发头。示例配置仅作准备，尚未部署域名/证书或开放公网：

```powershell
$env:PERSONAL_AGENT_MODE = 'server'
$env:PERSONAL_AGENT_STORAGE = 'sqlite'
$env:PERSONAL_AGENT_DATA_DIR = 'D:\PrivateAgent'
$env:PERSONAL_AGENT_PUBLIC_ORIGIN = 'https://research.your-domain.example'
$env:PERSONAL_AGENT_TRUSTED_PROXIES = '127.0.0.1'
$env:PERSONAL_AGENT_LISTEN_HOST = '127.0.0.1'
node server.mjs
```

代理须保留公开 Host，覆盖 `X-Forwarded-Proto: https`，并从配置的 loopback 地址连接。不要让外部客户端直连此 HTTP 端口。服务器模式缺少 HTTPS origin、SQLite 或已初始化管理员时拒绝启动；旧全量状态、导出、模型设置和 ThinkFlow 管理 API 不注册。管理页面使用 Secure/HttpOnly/SameSite=Strict cookie，写操作校验 Origin 和 CSRF；Watch 使用独立 Bearer 凭据。代理访问日志应排除 Authorization、Cookie、配对正文和资料正文。

`GET /api/v1/diagnostics` 只返回版本和随机request_id，可给M0B做真实网络探测。管理会话下的 `GET /api/v1/owner/readiness` 分别报告数据库短事务写探针、worker心跳、Capture、Ask模型配置和ThinkFlow状态。缺模型仅让Ask未就绪，ThinkFlow失败仅让集成降级。Linux自动重启、TLS代理和每日备份已有可审查配置及隔离验证，**尚未在常开主机启用生产服务、域名证书或备份定时器**，不能据此宣称常开交付完成。
