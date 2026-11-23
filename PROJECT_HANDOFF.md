# 当前版本交接

更新时间 2026-11-23。继续沿用 [目标设计](docs/WATCH_PRODUCT_DESIGN.md)。本机安装与配置入口见 [Mac 接手与真机验证](docs/APPLE_DELIVERY.md#mac-接手与真机验证)。

- [PR #1](https://github.com/Weihao-Zhou03/personal-research-agent/pull/1) 继续使用 `codex/watch-capture`，保留阶段提交，暂不合并。
- Mac 验证源码 `094e956392971c9108a4aa96404e73e9a8b7669a`。本机 Xcode 27.2 通过无签名 Watch 模拟器编译、wrapper 归档及 13 项检查；Node 135 项、Swift 30 项、Python 工具 17 项通过。历史 CI 仍对应 `5e874f40a208ebee6f1fb11400e9950efaeb0828`。
- Mac 浏览器用隔离 SQLite 与真实本机 ThinkFlow 完成导入、提问、引用核对、编辑及确认写回。q13 重放历史响应，在修订 2 补上「单用户串行」；重复确认仍为一份已核对文档。q32 用受控 HTTP 超时复现单次请求、用量未知、待人工核对。真实模型待 Mac 安全配置。 [逐项验证](docs/VERIFICATION.md#2026-11-23-mac-本机验证)
- 开发签名预检停在缺少 development team。待用户登录 Xcode、连接并信任设备、开启开发者模式，再核对设备系统、安装启动并读取 Watch 真实 HTTPS 诊断。随后才验配对、中文输入、离线保存和恢复去重。常开部署、TestFlight 与旧数据迁移待另行决定。
