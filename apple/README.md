# Apple Watch 客户端（M0A已通过 / M1待真机验收）

此目录新增原生 Watch 工程，不改变旧任务。Watch 不部署模型、不带模型密钥。界面包括记灵感、问资料、看简报和连接；问资料由后端能力标志控制，资料或云配置未就绪时不能新建问题。

工程使用 XcodeGen 2.46.0 的固定提交生成，Xcode 26.6、watchOS Deployment Target 10.0。`ResearchWatch` 是单一 SwiftUI 可执行 target；`PersonalResearch` 是 watch-only 分发 wrapper，不是新增 iPhone companion。归档 scheme 与模拟器 scheme 分开。工程、DerivedData、私钥和 profiles 均不提交。

在 macOS 26 / Xcode 26.6 运行：

```sh
bash scripts/apple-check.sh
```

脚本依次运行核心Swift单元测试、无签名模拟器build、无签名wrapper archive、真实归档结构检查。Windows本机不能执行这些Apple SDK检查。2026-10-21 [云端run39567460679](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39567460679)在 `196e2c4bd46461ed65bb892f8dfaca3a752efd41` 上通过23项Swift测试、Watch编译、archive和8项结构检查，包含Ask/限流新增逻辑。后续配置注入与发布脚本改动仍需新CI，签名与真机验收未完成。

客户端配置来自严格验证的非秘密JSON，构建脚本生成xcconfig并在归档后核对实际API、bundle、版本和构建号。普通CI明确使用 `apple/ci-config.json` 合成配置，不连接生产服务。真实配置从 `apple/delivery-config.example.json` 复制至忽略的 `apple/delivery-local.json`；真实后端必须使用有效HTTPS，没有ATS例外、任意重定向或内置账号。设备凭据由表端生成并保存在Keychain，不从GitHub Secrets注入设备。

`WatchCore` 可独立执行 `swift test --package-path apple/WatchCore`。它验证出站队列状态机、重启恢复、容量、身份与原空间冻结、重复发送字节、错误处理和 Node/Swift 凭据 hash 规则。测试中的 URLProtocol 是网络替身，不代表真实 Watch 或真实服务器验收。

所有队列数据保存在 Application Support，首次确认后原子落盘，再尝试联网；确认页固定核对过的文字、空间与身份，容量或磁盘错误直接显示在确认页。发生过 POST 的条目保持“提交结果待确认”，只使用相同请求 ID 和首次 payload 重试。缓存清理和解除连接不会清理未确认原文。设置中的独立“删除全部本机内容”必须再次确认：清除所有身份的本机原文与结果缓存、保留凭据，不删除或取消服务端内容；开始清理会取消本机请求，并隔离迟到响应及原轮询。仅打开应用或手动同步保证尝试上传；不保证后台自动同步。

Capture和Ask共用100条、1MiB的未确认容量，单条分别最多4000/1000个Unicode码点。429会将同身份同操作的发送截止时间持久化，重启和手动同步不能提前重试。Ask得到真实job ID后由后端继续执行；Watch只读状态与结构化简报，列表和详情前台按5/10/20/20秒有限更新，离开页面或后台不再轮询。Feed每页20条并使用服务端游标加载更早记录；打开、刷新和分页只发GET，不补发outbox或新建生成任务。每个任务独立标注读取时间，旧缓存缺少此字段时不推断时间。

当前业务补丁新增7项Swift回归（总计30项），覆盖只读列表、身份与清理隔离、迟到响应、退避、旧journal迁移及显式删除；Windows仅做静态核对，须由下一次macOS CI确认编译和测试。以上行为仍需真机、真实HTTPS服务与实际断网恢复验证。

更多分发门槛、配置清单与未完成事项见 [APPLE_DELIVERY.md](../docs/APPLE_DELIVERY.md)。
