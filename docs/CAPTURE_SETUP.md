# M1 Capture 运行与恢复

这是一条独立于旧研究任务的原文收集链路。当前可用：管理员登录、空间、配对批准/拒绝、设备撤销、Capture 原文保存、轻量 feed 和 Web 查看。索引意图会保存为 queued，中文索引、Ask 和结构化简报留到 M2；保存 Capture 不调用模型或 ThinkFlow。

## 在 Windows 隔离试用

使用 Node **24.19.0**；无需 npm install。保持原有 4317 服务与 `data` 原样，在新 PowerShell 窗口运行：

```powershell
node --version
$captureData = Join-Path $env:LOCALAPPDATA 'PersonalResearchAgent\capture-dev'
node scripts/init-owner.mjs --data-dir $captureData
$env:PERSONAL_AGENT_DATA_DIR = $captureData
$env:PERSONAL_AGENT_STORAGE = 'sqlite'
$env:PERSONAL_AGENT_MODE = 'local'
$env:PORT = '4319'
node server.mjs
```

初始化命令在终端隐藏输入至少12字符的管理员密码，只保存 scrypt 校验值。不要将密码写入命令参数、仓库、截图或聊天。重复初始化会拒绝修改已有密码；目前没有 Web 密码重置入口。自动化可以明确选择 `--password-stdin`，秘密由调用环境提供，不能把实际密码写进脚本。

打开 `http://127.0.0.1:4319/owner`。登录后创建空间，输入 Watch 显示的8位配对码，核对设备名和时间，选择允许空间与默认空间后批准。页面能拒绝配对和撤销设备。最近列表显示最多200条原文；`待索引` 不表示资料已可检索。设备 feed 只含标题与状态，完整原文不发给其他设备。

没有 Watch 时，`npm test` 用隔离数据库和真实 HTTP 验证相同接口；这是后端验证，不能替代真机断网、系统输入或 Keychain 验证。Watch 工程、构建命令和分发阻塞见 [APPLE_DELIVERY.md](APPLE_DELIVERY.md)。HTTP loopback 仅供电脑调试，Watch 的 127.0.0.1 指向手表自身，不能访问这台电脑。

关闭前台服务用 Ctrl+C。新窗口中的环境变量不影响原服务；再次运行同一目录会恢复已保存记录与设备身份。原来的 `start.cmd` 仍用于本机旧工作台，默认不启动 Ollama。

## 环境配置

| 名称 | 行为 |
| --- | --- |
| PERSONAL_AGENT_MODE | 默认 local；远程部署必须显式 server |
| PERSONAL_AGENT_STORAGE | 默认 json；Capture 必须 sqlite |
| PERSONAL_AGENT_DATA_DIR | 数据目录；默认仓库 data。试用必须指定隔离目录 |
| PERSONAL_AGENT_DATABASE | 可选数据库路径；默认数据目录/workspace.sqlite |
| PORT | HTTP 服务端口；默认4317 |
| PERSONAL_AGENT_PUBLIC_ORIGIN | server 必填，根 HTTPS origin，不含路径、凭据、query |
| PERSONAL_AGENT_TRUSTED_PROXIES | 显式可信 TLS 代理地址，逗号分隔；M1 只支持 loopback |
| PERSONAL_AGENT_LISTEN_HOST | 默认127.0.0.1；local 拒绝非 loopback |

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

数据库备份包含认证校验值，与普通 `/api/export` 业务导出不同，必须放在私有目录；原 JSON 原字节备份也可能带早期遗留字段。Windows 上需要自行设置目录 ACL，Node 文件 mode 不构成权限核验。ThinkFlow 原生资料目录和模型服务凭据需另行备份。尚无每日调度、保留策略或图形化恢复。

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

`GET /api/v1/diagnostics` 只返回版本和随机 request_id，可先给 M0B 做真实网络探测。它不是数据库/模型/worker readiness 检查。当前生产 HTTPS、自动重启、睡眠策略、定时备份和 readiness 心跳尚未部署；不能据此宣称常开服务完成。
