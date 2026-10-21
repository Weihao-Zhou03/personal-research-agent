# 项目阶段交接

更新时间：2026-10-21。分支 `codex/watch-capture`，起点 `f871d18`，目标 `docs/WATCH_PRODUCT_DESIGN.md`。开始时无未提交修改，没有适用 AGENTS.md；原数据目录保持原样。

## M0A：工程与契约已准备，云构建门槛待验证

差异与阶段计划见 `docs/BASELINE_AND_PLAN.md`，接口见 `docs/API_CONTRACT.md`，迁移与回退见 `docs/DATA_MIGRATION.md`。目标设计从下载文件原样复制，未把附件中的完成标准当作已实现事实。

新增 `apple/` SwiftUI Watch 工程、Foundation 核心包与15项待执行 Swift 测试；固定 XcodeGen2.46.0 与 Xcode26.6，watchOS10，最小 iOS watch-only wrapper 不含完整 companion。无 Apple Secrets 的 macOS CI 会测试核心、编译模拟器并检查无签名 wrapper archive；后端 CI 固定 Node24.19.0，分别在 Windows/Linux 运行。

本机可运行 `npm test` 与 `python scripts/apple-tools-test.py`。Windows 没有 Xcode/Swift；尚未产生真实 Apple build 证据。新工作流尚未推送或远端执行，推送授权已向用户请求，未得到答复不能执行。M0A 不能标记验收通过。

## M1：本地后端闭环已验证，Watch 验收待完成

新增可选 SQLite 适配、显式 JSON 迁移核验、一致性备份与新路径恢复；旧 JSON 默认路径不变，未迁移现用数据。旧 queued/running 重启仍标失败等待人工重跑；来源快照、人工确认、写回锁定与读回核对继续保留。

新增 owner 密码/会话/CSRF、短码配对、设备范围与撤销、原文 Capture、幂等与轻量 feed。Capture、owner 级幂等记录及索引意图同事务提交，保存不依赖 LLM、ThinkFlow 或索引。`jobs.index_capture` 仍 queued，Ask 明确禁用；没有把旧 Markdown 处理当作新检索简报。

Watch 代码提供 Keychain pending/active 分离、Application Support 原子 outbox、固定首次 payload/空间/身份、提交未知状态、100条/1MiB容量、前台同步与缓存隔离。Swift 代码未编译测试，不把代码存在等同于真机可靠性已验证。

管理页面 `/owner` 可登录、建空间、核对与批准/拒绝配对、撤销设备、查看最近200条原文；继承已有研究手记风格。隔离运行命令见 `docs/CAPTURE_SETUP.md`。`start.cmd` 用于旧本机工作台；Ollama 改为 `-StartOllama` 显式选择，不下载或默认启动本地生成模型。

验证：Node 共60项（原30项保留）通过；Apple Python工具5项通过。独立4319端口真实进程、真实SQLite、合成输入完成浏览器登录→建空间→核对批准→HTTP保存/重传→原文可见→刷新会话恢复→撤销401→退出清理。响应正文丢失、重启和重新配对使用同一ID的恢复也有实际HTTP/SQLite自动测试。现用 `data/workspace.json` 前后hash相同。没有调用云模型，没有接入真实Watch。详细证据及限制见 `docs/VERIFICATION.md`。

## M0B：提前完成配置检查与结构方案，真实分发阻塞

见 `docs/APPLE_DELIVERY.md` 与 `apple/delivery-manifest.json`。非秘密配置预检和归档结构检查器可本地运行；`watch-testflight.yml` 仅 readiness 模板，**没有签名或上传能力**。未生成IPA、未上传ASC、未安装真机。

外部条件：允许公开新分支并运行CI；可用macOS/Xcode构建证据；真实Apple Developer/ASC权限、Team/bundle IDs、P12及相应profiles、ASC P8；Watch可达HTTPS后端；目标Watch/iPhone型号系统与测试人员。用户只在安全配置界面录入秘密，不贴聊天。账号注册/费用、实际签名上传、生产迁移另按明确授权执行。

## 下一步

1. 获得推送授权后运行现有无Secrets CI，先修正真实编译暴露的问题；没有日志不能宣称M0A完成。
2. 配置真实HTTPS与Apple非秘密标识，准备可审查签名方案，再按授权做TestFlight分发；真机显示真实diagnostics响应才通过M0B。
3. 用真机执行离线、应用重启、响应丢失、空间冻结、重新配对/撤销与身份隔离矩阵，完成M1验收。
4. M2再实现中文资料同步/版本化索引、持久Ask与lease/预算、结构化简报及引用核验；M3再扩展新修订写回。不扩大未通过M0B的Watch装饰性功能。
