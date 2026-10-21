# 单机 Linux 部署与恢复

这里提供可审查的配置与命令，不会自动租服务器、申请域名、修改系统服务、迁移现用数据或开放公网。首版只运行一个Node进程和同机持久SQLite，不放共享网络盘，不启动多个worker副本。Windows/WSL能用于验证；宿主机睡眠、关机、断网或WSL停止仍会中断服务，不能据此宣称常开部署完成。

## 目录与固定运行时

示例适用Linux x86_64、systemd：代码 `/opt/personal-research-agent`；Node `/opt/node-v24.19.0-linux-x64/bin/node`；数据 `/var/lib/personal-research-agent`；私有备份 `/var/backups/personal-research-agent`。ARM64需换成同版本正确架构的官方包并修改unit路径，当前未实测。操作者先创建无交互服务账户 `personalagent`，数据和备份目录归该账户、权限700；代码归管理员且服务账户只读。

从 [Node官方24.19.0目录](https://nodejs.org/dist/v24.19.0/) 下载与架构匹配的压缩包和 `SHASUMS256.txt`，按官方哈希核对后解压。不要默默使用系统的不同Node版本。运行：

```sh
/opt/node-v24.19.0-linux-x64/bin/node --version
/opt/node-v24.19.0-linux-x64/bin/node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';let d=new DatabaseSync(':memory:');console.log(d.prepare('select sqlite_version() as version').get());d.exec('create virtual table probe using fts5(tokens)');d.close()"
npm test
```

预期Node为24.19.0、SQLite至少3.51.3且FTS5可用。npm也应来自该Node目录；项目后端不需要npm安装依赖。

## 首次初始化与显式迁移

全新目录可运行 `node scripts/init-owner.mjs --data-dir /var/lib/personal-research-agent`，在终端隐藏输入管理员密码；不要写密码命令行或聊天。旧项目必须先停原写入者、私下备份，再按既有 `docs/DATA_MIGRATION.md` 执行 `scripts/migrate-workspace.mjs`；初始化不能用空库接管旧JSON。迁移后保留原JSON且不双写。正式数据切换属于单独审查动作，本说明没有执行它。

复制环境示例到Git之外：`personal-research-agent.env.example` → `/etc/personal-research-agent.env`，`backup.env.example` → `/etc/personal-research-agent-backup.env`。文件归 `root:personalagent`、权限640，仅服务账户可读。用安全编辑器填真实域名；需要Ask时配 `PERSONAL_AGENT_MODEL_BASE_URL`、`PERSONAL_AGENT_MODEL`，将密钥放私有 `PERSONAL_AGENT_MODEL_KEY_FILE`，或私有环境文件的 `PERSONAL_AGENT_MODEL_KEY`。key仅适用于匹配的base URL；管理页临时输入的key只驻内存，重启后不能假定仍在。EnvironmentFile按systemd语法解析，不要通过 `source` 执行。管理员密码由初始化命令处理，不放此文件。服务端key不放Watch配置、普通导出或日志。[systemd执行环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

将 `personal-research-agent.service` 复制到 `/etc/systemd/system/`，检查绝对路径与账户，再由操作者执行：

```sh
sudo systemd-analyze verify /etc/systemd/system/personal-research-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now personal-research-agent.service
sudo systemctl status personal-research-agent.service
sudo journalctl -u personal-research-agent.service --since today
```

unit使用失败重启、启动频率限制、权限隔离和私有文件掩码；这些是配置行为，不能代替真实主机重启演练。[systemd服务](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

## 同机 HTTPS 代理

按 [Caddy官方安装说明](https://caddyserver.com/docs/install) 安装受维护版本。将 `Caddyfile.example` 中域名与服务的 `PERSONAL_AGENT_PUBLIC_ORIGIN` 一起替换，正确配置DNS及主机防火墙；这些外部配置本轮未执行。代理只转发Node，**不暴露ThinkFlow**。同机Caddy覆盖转发头，Node只信任127.0.0.1代理并要求public Host/Origin；不要加入任意网段或信任客户端传入的HTTPS标记。没有真实证书/域名不应把HTTP地址发给Watch。[Caddy反向代理请求头](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers)

操作者运行 `caddy validate --config /etc/caddy/Caddyfile` 后再reload。首次证书申请、真实TLS、外网访问与防火墙需要在目标主机单独验收。Caddy与Node共同在单机运行；额外CDN或多级代理需要另行明确可信链。

## 存活、就绪与故障观察

`GET /api/v1/diagnostics` 为无敏感信息liveness，返回版本和request_id；它不能证明数据库可写或模型可用。服务器模式只接受实际HTTPS或可信同机代理，所以本机人工排查可用 `curl -H 'Host: 真实域名' -H 'X-Forwarded-Proto: https' http://127.0.0.1:4317/api/v1/diagnostics`，公网则直接用HTTPS域名。

管理页登录后读取 `GET /api/v1/owner/readiness`：分别检查数据库写探针、worker真实心跳、Capture、模型配置与Ask、ThinkFlow。缺模型只让Ask未就绪；ThinkFlow不可达使集成降级，已同步快照检索与原文Capture继续工作。不要把无认证readiness接到公开监控；日志和认证cookie保存在私有位置。故障观察包括systemd重启次数、worker心跳、`needs_attention`任务、备份最近成功时间和磁盘空间。

## 每日一致性备份与新目录恢复

`scripts/backup-scheduled.mjs` 使用SQLite支持的backup API，含活跃WAL，不直接复制正在写入的单个.sqlite文件。每份新备份先通过hash、integrity、FK与表内容核验，再删除超出保留数量的**本脚本标记且仍通过核验的备份对**。默认保留7份，可配置1–365。未标记手工备份、格式不匹配、hash被修改、目录外引用和无关文件全部保留；不递归清目录。失败新备份不会清旧备份。锁已存在时停止，不猜测PID后自动清锁；先检查旧进程再人工处理。

```sh
node scripts/backup-scheduled.mjs --database /var/lib/personal-research-agent/workspace.sqlite --backup-dir /var/backups/personal-research-agent --retain 7
```

复制backup service和timer到 `/etc/systemd/system/`，校验路径后由操作者启用 `personal-research-agent-backup.timer`。默认主机本地时间每天03:15，加最多5分钟错峰；`Persistent=true`在停机后补执行一次，不会补齐每个错过的日期。[systemd定时器](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

备份是**私有运维数据**，含设备认证校验值/会话，不能上传公开仓库或当业务导出。另行备份ThinkFlow原始outputs及版本目录、环境配置版本、外部管理密钥；密钥与普通业务数据分开存储。同机7份只防误删/回退，不防磁盘丢失；私有异机副本由操作者配置。

在全新私有目录恢复演练：

```sh
node scripts/backup-workspace.mjs restore --backup /var/backups/personal-research-agent/明确选中的备份.sqlite --database /var/lib/personal-research-agent-restore/workspace.sqlite
```

命令拒绝现有目标，核对manifest、整库hash、schema和每表内容后才返回 `verified:true`。随后用隔离端口、隔离数据目录启动副本，核对原文、历史引用和任务计数。不得直接覆盖生产库；切换前停服务并单独审查新增数据差异。Windows上的Node不能保证ACL，需要用户选择真正私有的备份目录。

## ThinkFlow Linux 安装与隔离 smoke

此轮补充Linux真实目录和符号链接，不把Windows junction方案称为跨平台支持。脚本固定上游提交 `1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3`，使用仓库 `scripts/thinkflow-requirements.lock` 精确Python依赖和上游package-lock/npm ci构建前端；要求Node24.19.0、uv0.12.15。uv只向指定私有root写Python3.11环境与cache，不全局安装。uv可从[官方0.12.15发行版](https://github.com/astral-sh/uv/releases/tag/0.12.15)下载并核对同版sha256。未下载任何本地生成模型。

```sh
bash scripts/setup-thinkflow-linux.sh --root /var/lib/personal-research-agent/thinkflow --outputs /var/lib/personal-research-agent/thinkflow-outputs
THINKFLOW_SOURCE_ROOT=/var/lib/personal-research-agent/thinkflow/source THINKFLOW_PORT=8437 /var/lib/personal-research-agent/thinkflow/venv/bin/python /var/lib/personal-research-agent/thinkflow/run-linux.py
```

已有checkout版本不符、修改/未跟踪文件、outputs有非空数据或映射不符时停止，不自动搬移或删原数据。服务启动始终loopback，可使用 `thinkflow.service.example`；源与outputs均需service账户私有权限。固定上游内部key是兼容标记，不是公网身份认证；ThinkFlow仅限本机集成。

首次验证应选择另一套全新private root/outputs及端口18437：

```sh
THINKFLOW_SOURCE_ROOT=隔离目录/source THINKFLOW_PORT=18437 隔离目录/venv/bin/python 隔离目录/run-linux.py
node scripts/smoke-thinkflow.mjs --base-url http://127.0.0.1:18437 --allow-write
```

smoke会创建自己的新笔记本、写入合成中文资料、按真实来源列表读取、创建确认文档并读回、重复写入核对仍只有一份。随后真实同步到隔离SQLite，用显式标注的生成替身完成结果，再验证M3确认写回、同intent去重、人工核对和第二修订独立文档。它拒绝8437端口，必须显式 `--allow-write`；不会碰用户现有笔记本。真实模型调用0，合成生成替身1次。

真实检查发现固定上游 `fastapi_app/source_manager.py:103` 在导入文本时先 `.strip()` 再写文件，因此ThinkFlow保存的资料不含原导入请求首尾空白。本项目同步按上游实际已存正文建立精确快照和hash，不伪称上游保留了导入请求全部字节，也不暗改固定上游。项目直接导入和Capture仍完整保留本地原文。合成输入+真实上游HTTP不能代替私人资料质量、真实模型或真机验收。

## 本轮验证边界

2026-10-21在Ubuntu WSL2 x86_64实际完成固定上游克隆、184项锁定Python依赖安装、`npm ci`和Vite前端build。Node24.19.0与uv0.12.15下载包通过官方校验文件核对，实测Python3.11.16。独立18437端口真实服务及独立outputs通过上述全部HTTP smoke；旧写回与M3确认/修订写回均真实读回，生成仍为测试替身。现有8437和用户数据目录未使用。

Node临时目录测试覆盖日备保留、WAL一致性、新目录恢复及历史引用/FTS核验、失败不清旧、未管理文件保留、被修改备份保留、路径逃逸拒绝和互斥锁。Windows与WSL分别执行。Caddy2.11.7官方包通过SHA-512校验，`caddy validate`结果为Valid configuration；只验证配置，不启动Caddy、不申请证书。systemd255对私有副本完成语法校验（仅将示例Node可执行路径替换为本次便携Node实际路径；原示例路径在WSL不存在），没有安装或启动unit。

未配置常开服务器、真实域名、生产systemd服务、外网TLS、异机备份、Apple账户或TestFlight；这些必须独立验收，配置文件本身不是交付证明。Windows/WSL宿主机关闭时本次服务不能继续运行。
