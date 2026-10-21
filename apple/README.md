# Apple Watch 客户端（M0A已通过 / M1待真机验收）

此目录新增原生 Watch 工程，不改变现有网页或旧任务。Watch 不部署模型、不带模型密钥。当前界面只开放记灵感、最近记录和连接；问资料属于后续 M2。

工程使用 XcodeGen 2.46.0 的固定提交生成，Xcode 26.6、watchOS Deployment Target 10.0。`ResearchWatch` 是单一 SwiftUI 可执行 target；`PersonalResearch` 是 watch-only 分发 wrapper，不是新增 iPhone companion。归档 scheme 与模拟器 scheme 分开。工程、DerivedData、私钥和 profiles 均不提交。

在 macOS 26 / Xcode 26.6 运行：

```sh
bash scripts/apple-check.sh
```

脚本依次运行核心Swift单元测试、无签名模拟器build、无签名wrapper archive、真实归档结构检查。Windows本机不能执行这些Apple SDK检查。2026-10-21 [云端run39563062510](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39563062510)已成功：15项Swift测试、Watch编译、archive和8项结构检查通过；M0A真实build门槛已过，签名与真机验收仍未完成。

客户端的 HTTPS 地址由 `API_BASE_URL` build setting 写入 Info.plist，默认是不可用的占位地址。真实后端必须使用有效 HTTPS；没有 ATS 例外、任意重定向或内置账号。连接前可在设置读取 `/api/v1/diagnostics` 的真实响应。身份凭据由表端生成并保存在 Keychain，不从 GitHub Secrets 注入设备。

`WatchCore` 可独立执行 `swift test --package-path apple/WatchCore`。它验证出站队列状态机、重启恢复、容量、身份与原空间冻结、重复发送字节、错误处理和 Node/Swift 凭据 hash 规则。测试中的 URLProtocol 是网络替身，不代表真实 Watch 或真实服务器验收。

所有队列数据保存在 Application Support，首次确认后原子落盘，再尝试联网；发生过 POST 的条目保持“提交结果待确认”，只使用相同请求 ID 和首次 payload 重试。缓存清理不会清理未确认原文。仅打开应用或手动同步保证尝试上传；不保证后台自动同步。

更多分发门槛、配置清单与未完成事项见 [APPLE_DELIVERY.md](../docs/APPLE_DELIVERY.md)。
