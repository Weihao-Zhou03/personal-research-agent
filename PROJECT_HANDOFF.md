# 项目阶段交接

更新时间：2026-10-21。分支 `codex/watch-capture`，起点 `f871d18`，目标 `docs/WATCH_PRODUCT_DESIGN.md`。开始时无未提交修改，没有适用 AGENTS.md；原数据目录保持原样。

## M0A：契约、工程与真实云构建门槛已通过

差异与阶段计划见 `docs/BASELINE_AND_PLAN.md`，接口见 `docs/API_CONTRACT.md`，迁移与回退见 `docs/DATA_MIGRATION.md`。目标设计从下载文件原样复制，未把附件中的完成标准当作已实现事实。

新增 `apple/` SwiftUI Watch 工程、Foundation核心包与15项已通过的Swift测试；固定XcodeGen2.46.0与Xcode26.6，watchOS10最低部署版本，最小iOS watch-only wrapper不含完整companion。无Apple Secrets的macOS CI已测试核心、编译模拟器并检查无签名wrapper archive；后端CI固定Node24.19.0，Windows/Linux分别各60项通过。

本机可运行 `npm test` 与 `python scripts/apple-tools-test.py`。已按最新授权推送公开分支并运行无Apple Secrets CI。Windows/Linux检查run39562283359成功；首轮Swift泛型类型位置错误已最小修复，第二轮macOS run39563062510成功：15项核心测试、Watch模拟器build、无签名archive、8项实际归档检查全部通过。实测Xcode26.6(17F113)、Swift6.3.3、watchOS SDK26.5。构建源码提交c8e0e32264b709963bd70f4be50449dc609eee98；后端检查源码6d43b1105144085cf3d983052ded6265a2ad9124，此后仅修改Swift及文档，后端源未变。详见`docs/VERIFICATION.md`。

## M1：本地后端闭环已验证，Watch 验收待完成

新增可选 SQLite 适配、显式 JSON 迁移核验、一致性备份与新路径恢复；旧 JSON 默认路径不变，未迁移现用数据。旧 queued/running 重启仍标失败等待人工重跑；来源快照、人工确认、写回锁定与读回核对继续保留。

新增 owner 密码/会话/CSRF、短码配对、设备范围与撤销、原文 Capture、幂等与轻量 feed。Capture、owner 级幂等记录及索引意图同事务提交，保存不依赖 LLM、ThinkFlow 或索引。`jobs.index_capture` 仍 queued，Ask 明确禁用；没有把旧 Markdown 处理当作新检索简报。

Watch代码提供Keychain pending/active分离、Application Support原子outbox、固定首次payload/空间/身份、提交未知状态、100条/1MiB容量、前台同步与缓存隔离。Swift核心在macOS通过15项测试，Watch App通过SDK编译与归档；Keychain、系统输入、前后台网络和真实设备可靠性仍未验证。

管理页面 `/owner` 可登录、建空间、核对与批准/拒绝配对、撤销设备、查看最近200条原文；继承已有研究手记风格。隔离运行命令见 `docs/CAPTURE_SETUP.md`。`start.cmd` 用于旧本机工作台；Ollama 改为 `-StartOllama` 显式选择，不下载或默认启动本地生成模型。

验证：Node 共60项（原30项保留）通过；Apple Python工具5项通过。独立4319端口真实进程、真实SQLite、合成输入完成浏览器登录→建空间→核对批准→HTTP保存/重传→原文可见→刷新会话恢复→撤销401→退出清理。响应正文丢失、重启和重新配对使用同一ID的恢复也有实际HTTP/SQLite自动测试。现用 `data/workspace.json` 前后hash相同。没有调用云模型，没有接入真实Watch。详细证据及限制见 `docs/VERIFICATION.md`。

## M0B：提前完成配置检查与结构方案，真实分发阻塞

见 `docs/APPLE_DELIVERY.md` 与 `apple/delivery-manifest.json`。非秘密配置预检和归档结构检查器可本地运行；`watch-testflight.yml` 仅 readiness 模板，**没有签名或上传能力**。未生成IPA、未上传ASC、未安装真机。

公开新分支与无Apple Secrets CI已获本轮授权并完成，真实无签名构建证据已取得。其余外部条件：真实Apple Developer/ASC权限、Team/bundle IDs、P12及相应profiles、ASC P8；Watch可达HTTPS后端；目标Watch/iPhone型号系统与测试人员。用户只在安全配置界面录入秘密，不贴聊天。账号注册/费用、实际签名上传、生产迁移另按明确授权执行。

## 下一步

1. M0A已通过；源码或工具链后续变化时重跑无Secrets CI。当前归档使用占位bundle IDs，不作为可安装发行版。
2. 配置真实HTTPS与Apple非秘密标识，准备可审查签名方案，再按授权做TestFlight分发；真机显示真实diagnostics响应才通过M0B。
3. 用真机执行离线、应用重启、响应丢失、空间冻结、重新配对/撤销与身份隔离矩阵，完成M1验收。
4. M2再实现中文资料同步/版本化索引、持久Ask与lease/预算、结构化简报及引用核验；M3再扩展新修订写回。不扩大未通过M0B的Watch装饰性功能。
