# Watch 实施基线与阶段计划

核对日期：2026-10-21。目标设计为 `docs/WATCH_PRODUCT_DESIGN.md`，从用户提供的下载文件原样复制，SHA-256 为 `0849edaf6df25707e1487198a269fd4dd909bc307c6e03ae49e8f3b613a85bba`。设计是待实施目标，不是验收结果。

## M0A 基线核对

开始时 HEAD 与设计基线均为 `f871d18c313ee91c09874f3efe13b3c321a8cf84`；`git diff`、暂存区和未跟踪文件均为空。没有找到仓库或祖先目录的 `AGENTS.md`。已读取 README、现有服务、模型与 ThinkFlow 适配器和测试。原 30 项测试在 Windows Node 24.19.0 上通过。改动在本地分支 `codex/watch-capture`，不覆盖 main，不自动推送公开仓库。

| 设计职责 | 基线现状 | 第一批实施 |
| --- | --- | --- |
| Watch 工程与云端编译 | 不存在 | 独立 apple 目录、watch-only 工程描述、无 Apple Secrets CI |
| 后端存储 | workspace.json 整体原子替换 | 可选择 SQLite 存储；显式离线迁移与核验，禁止隐式空库替换 |
| 远程身份 | 只有本机 Host/Origin 限制 | owner 会话与设备凭据分离，服务器模式缺项拒绝启动 |
| Capture | 不存在 | 先保存原文、幂等记录和索引意图；模型调用数为零 |
| Watch 本地可靠性 | 不存在 | 持久 outbox、原 payload 重传、提交未知状态、身份分区 |
| Ask 检索与简报 | 旧整文处理和 Markdown | M2 实现；M1 capabilities 明确 ask=false |
| 旧任务恢复 | queued/running 重启变 failed | 保留，不能套用新任务自动恢复 |
| 来源与归档 | 已有快照、人工确认、写回读回 | 原样兼容；新版多修订写回延后 M3，不偷偷变更旧查重语义 |

## 实施顺序与门槛

1. M0A：冻结 API/迁移契约、建立 Watch 与 CI 最小工程。Windows 检查不替代 macOS build；云端 build 未运行时门槛仍未通过。
2. M0B 并行预检：工程 target/scheme/bundle/profile 清单与安全配置说明；核对当前 Apple 要求。没有账号、Secrets、HTTPS 地址与目标设备时不执行分发，也不计完成。
3. M1：在临时目录验证 SQLite 迁移、owner 登录、设备配对与撤销、Capture 幂等、Web 查看、表端 outbox。业务原文保存不依赖模型、ThinkFlow 或索引成功。
4. M2：中文分词、版本化全文索引、持久 Ask/lease/预算、结构化简报及引用验证。不能以 M1 的 queued 索引意图宣称检索已实现。
5. M3/M4：新修订归档、跨系统待核对状态、恢复演练、常开部署和真实手表验收。

每阶段更新 `PROJECT_HANDOFF.md` 和 `docs/VERIFICATION.md`。对外推送、TestFlight 上传、创建收费账号或切换生产数据前，先提供具体差异与复现证据并取得本轮明确授权。普通本地实现、隔离测试及可回退配置不逐步询问。

## 最小兼容修正

- 采用已在本机探测到的 Node **24.19.0**，而非设计引用的另一个补丁版本；SQLite 为 3.53.3，支持 FTS5。CI 固定相同运行时，Windows/Linux 分别验证。`node:sqlite` 是同步 API，短事务内不等待外部 HTTP。
- Watch-only 允许平台需要的 iOS wrapper stub；不由此扩建完整 companion 产品。真正 target 与归档结构以 macOS 构建产物为证据。
- 本机兼容模式继续支持旧 API；服务器模式不暴露旧的全量状态、导出、模型设置和 ThinkFlow 管理 API。不能把改监听地址当作服务器模式实现。
- 本次开发不迁移、修改或清空现用 `data/workspace.json`，不下载或默认启动本地生成模型。
