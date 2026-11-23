# 当前版本交接

更新时间 2026-11-23。用户已有 Mac，接手时先读 [Mac 接手与真机验证](docs/APPLE_DELIVERY.md#mac-接手与真机验证)。Codex 主导设计核对、自审、实现与验证，继续沿用 [目标设计](docs/WATCH_PRODUCT_DESIGN.md)。

- [PR #1](https://github.com/Weihao-Zhou03/personal-research-agent/pull/1) 继续使用 `codex/watch-capture`，保留阶段提交，暂不合并。
- M0A 已通过云端无签名构建。M1–M3 已实现记录、资料检索、持久问答、引用、人工审阅和 ThinkFlow 写回核对。M4 的 Linux 部署与备份恢复工具已准备，常开主机尚未部署。
- 验证源码 `5e874f40a208ebee6f1fb11400e9950efaeb0828`。[后端 CI](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39573171787) Windows/Linux 各 135 项通过。[macOS CI](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39573171480) 通过 30 项 Swift、17 项工具测试和无签名构建。隔离环境曾用真实模型和 ThinkFlow 跑通写回与读回，细节见 [验证记录](docs/VERIFICATION.md)。
- Mac 上先核对 Xcode 和设备兼容性，再用免费 Personal Team 尝试本地签名、安装及 Watch 上的真实 HTTPS 诊断。设备型号和系统、开发者模式、Watch 可达的 HTTPS 后端仍待确认。TestFlight 与真机尚未验收。
- 同时补完桌面网页的确认回写操作验收，复核 q13 简报遗漏「单用户串行」条件和 q32 超时结果未知。使用新建隔离 SQLite 数据目录。原 Windows 数据、代理 OAuth、本机密钥和 ThinkFlow 运行目录需分别管理。
