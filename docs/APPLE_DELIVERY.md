# Apple Watch 工程与真机分发

核查日期：2026-10-21。当前是可审查的工程和分发预检；**没有完成 Apple SDK 编译、签名、上传或真机安装**。开发环境为 Windows，未取得可运行的 macOS/Xcode、Apple 账号配置、签名材料和目标手表信息。本文件不以 Mock、IPA 或模拟器结果代替真机验收。

## M0A 已实现与待验证

- `apple/project.yml`：XcodeGen 2.46.0（提交 `8445e778451c7e44237b90281bde622d764b0084`），明确 Xcode 26.6、watchOS 10.0 Deployment Target 和共享 scheme。
- `ResearchWatch`：现代单 target SwiftUI Watch App；`PersonalResearch`：Apple watch-only 分发所需 iOS wrapper stub，不创建 iPhone 可执行界面。没有旧式 WatchKit Extension 业务 target。
- `scripts/apple-check.sh`：核心测试、无签名 Watch 模拟器 build、无签名 wrapper archive、归档实际产品检查分别执行；不是发布脚本。
- `.github/workflows/watch-check.yml`：macos-26 runner、固定 Xcode 路径，只读仓库权限，无 Apple Secrets；保存日志和检查结果。
- `.github/workflows/watch-testflight.yml`：仅手动触发的 readiness 模板；没有签名、Secrets 读取或上传步骤，不能执行发布。

Apple 官方确认 watch-only 工程仍需要分发 wrapper；该 stub 不在配对 iPhone 上安装可执行应用。[Apple 独立 Watch 应用](https://developer.apple.com/documentation/watchos-apps/creating-independent-watchos-apps)

截至核查日，App Store Connect 上传要求 Xcode 26+ 与对应 26 SDK。SDK 与最低部署版本分开配置，本工程暂保留 watchOS 10.0；旧手表兼容性仍需目标真机验证。[Apple SDK 要求](https://developer.apple.com/news/upcoming-requirements/?id=04282026a)

GitHub runner 当前清单列出 macos-26 的 Xcode 26.6。本项目显式检查 `/Applications/Xcode_26.6.app`，缺失即失败，不静默切换到 `latest`。runner 镜像仍会更新，构建记录以实际日志为准。[runner 官方清单](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md)

XcodeGen 支持 wrapper 类型和独立 watchOS target；生成成功仍不能证明归档或商店分发成功。[XcodeGen 规范](https://github.com/yonaskolb/XcodeGen/blob/2.46.0/Docs/ProjectSpec.md)

### SwiftUI 平台 API 核查

2026-10-21 直接读取 Apple 官方 DocC JSON 的 `metadata.platforms` 和声明（不是按 API 名称推测）。当前 UI 使用的下列签名均覆盖 watchOS 10：

| 实际签名 | Apple 标注的 watchOS 最低版本 | 官方证据 |
| --- | --- | --- |
| `TextField.init(_:text:axis:)`，`LocalizedStringKey` 重载 | 9.0 | [精确重载](https://developer.apple.com/documentation/swiftui/textfield/init(_:text:axis:)-7n1bm) |
| 同名 `StringProtocol` 重载 | 9.0 | [精确重载](https://developer.apple.com/documentation/swiftui/textfield/init(_:text:axis:)-8rujz) |
| `Form.init(content:)` | 6.0 | [Apple Form](https://developer.apple.com/documentation/swiftui/form/init(content:)) |
| `NavigationStack.init(root:)` | 9.0 | [Apple NavigationStack](https://developer.apple.com/documentation/swiftui/navigationstack/init(root:)) |
| `sheet(isPresented:onDismiss:content:)` | 6.0 | [Apple sheet](https://developer.apple.com/documentation/swiftui/view/sheet(ispresented:ondismiss:content:)) |
| `onChange(of:initial:_:)`，闭包 `(V,V) -> Void` | 10.0 | [Apple 双参数重载](https://developer.apple.com/documentation/swiftui/view/onchange(of:initial:_:)-4psgg) |

原始结构化证据地址是在上述 `/documentation/…` 路径前加 `/tutorials/data`，末尾加 `.json`。例如 `https://developer.apple.com/tutorials/data/documentation/swiftui/textfield/init(_:text:axis:)-7n1bm.json`。`axis` 是偏好，控件样式可能不遵循该方向；API 可用不保证手表呈现多行编辑。确认页使用独立滚动正文，中文输入、换行和实际交互仍须真机验收。没有发现需要提高最低系统版本的明确冲突，因此未扩展 UI 或删除系统输入。

wrapper 结构同时依据 Apple 独立 Watch 文档与[固定版 XcodeGen 生成器实现](https://github.com/yonaskolb/XcodeGen/blob/2.46.0/Sources/XcodeGenKit/PBXProjGenerator.swift)：生成器将 watchOS App 依赖复制到 wrapper 的 `Watch` 目录。该源码核查不能替代实际 archive 中的产品检查；候选工程状态仍为未构建验证。

### 运行与复现

在拥有 Xcode 26.6 的 macOS 执行仓库根目录命令：

```sh
bash scripts/apple-check.sh
```

无密钥 CI 可由后续经授权提交到远端后触发，或在 GitHub Actions 手动运行 Watch unsigned checks。本轮未推送、未创建远端构建，因此不能填“CI 已通过”。所需关键证据：

| 证据 | 产生位置 | 目前结果 |
| --- | --- | --- |
| Swift 核心测试 | `apple/Generated/check/swift-test.log` | 待 macOS 执行 |
| Watch 模拟器 build | `watch-simulator-build.log` | 待 macOS 执行 |
| wrapper archive | `unsigned-archive.log` | 待 macOS 执行 |
| 实际嵌入与 bundle 检查 | `archive-inspection.json` | 待归档产生 |
| 签名/上传/TestFlight/真机 | 独立发布与人工记录 | 未执行 |

`apple/delivery-manifest.json` 列出了当前候选 target、bundle setting、scheme、archive destination。其状态明确为 `candidate_not_build_verified`。只有检查实际归档后才确认需要哪些 profile，不把 profile 数量先写死。生成工程未纳入仓库；源码和声明式规范可重复生成。

## M1 客户端行为

客户端按已定义的 v1 snake_case 接口连接，不引用旧 `/api/state` 或管理员凭据：

| 功能 | 接口 |
| --- | --- |
| 无敏感诊断 | `GET /api/v1/diagnostics` |
| 申请/重放配对 | `POST /api/v1/pairings` |
| 核对配对 | `GET /api/v1/pairings/{id}`，Bearer 表端 secret |
| 核对身份/允许空间 | `GET /api/v1/watch/me` |
| 原文保存 | `POST /api/v1/watch/captures`，固定 `Idempotency-Key` |
| 最近记录 | `GET /api/v1/watch/feed`，缓存读取不生成内容 |

表端通过系统输入文字，用户核对正文和空间后才确认。没有自建录音、ASR、常驻监听或本地模型。听写是否可用仍取决于实际手表、语言与网络，不承诺中文离线听写。

队列每项冻结首次正文、客户端时间、请求 ID、请求 body 字节、空间、后端 origin、部署 ID 和拥有者 ID。先原子写入 Application Support，再发请求；启动 POST 之前将状态持久化为 `submission_unknown`。未得到可靠响应时使用相同 ID 与 payload 重试，绝不生成另一份 Capture。只有从未尝试过 POST 的项可直接取消。

允许单条最多 4,000 个 Unicode scalar（与 Node 码点计数一致），最多 100 条未确认项、总正文 1 MiB；超限拒绝新增，不覆盖或截断旧项。服务器明确返回 ID、匹配原空间且状态为 saved 后，才持久化为已确认；已确认项不占待发送容量。清缓存只处理已同步内容，不删除 pending、unknown 或 blocked 原文。

每次同步先读 `me` 比较部署和拥有者；旧身份队列冻结，原空间失效则保留原文，不自动改投默认空间。Feed 缓存带身份标记，身份不匹配时不显示。Keychain 中 pending 配对与 active 连接分开；先保存新身份与 secret，再切换 active，失败配对不破坏旧连接。默认空间变更不改变既有队列。

当前只实现前台/手动同步，不作后台实时承诺。配对查询每 5 秒、最多约 1 分钟；应用失去前台时不再发起轮询。原文保存不依赖模型，Ask 页面未开放。最近记录当前只加载服务端前 20 项，分页继续加载属于后续工作，不宣称已完成完整设计的任务与简报页。

## M0B 尽早验证路径

1. **先获得无签名证据**：运行 watch-check，核对 wrapper 下 `Watch/ResearchWatch.app`、可执行文件、独立运行标记、版本与 bundle 关联。若失败，修正最小工程，不暗中增加完整 iPhone companion。
2. **确定非秘密配置**：确认目标 Watch 型号、watchOS、配对 iPhone 系统、Team ID、可用 bundle IDs、实际 HTTPS 域名、ASC 数字应用 ID、Key ID/Issuer ID。真实设备信息尚缺。
3. **用户自行处理账号**：Apple Developer Program、协议、身份验证和任何付费操作由用户明确授权并自行完成；本轮未创建账号资源或付款。
4. **审查 target/profile 映射**：按实际归档 target 注册明确 App IDs，profile 与 Distribution 证书配对。App Store Connect 的 watch-only 记录按 Apple 流程选择 iOS，并不要求完整 companion。[Apple watchOS 记录](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-watchos-app-information)
5. **用户自行录入 Secrets**：Distribution P12/密码、各实际 target 的 provisioning profile、ASC team API P8 放进 GitHub `apple-testflight` 受保护环境，不贴聊天。P8 是上传认证，P12 是签名，不可互换；Issuer ID 不是 Team ID。环境启用 required reviewers。[GitHub 签名流程](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
6. **具体发布审查后再启用上传**：后续发布脚本需预检缺项（只显示名称）、临时 Keychain、证书有效期、实际 profile 映射、递增 build number、签名 archive、当前 Xcode export 参数、上传与 always 清理。发布任务串行，只运行受信任 revision，PR 不接触发布 Secrets。当前 readiness 模板无此能力。
7. **分开记录外部结果**：签名归档→导出→ASC 上传→处理完成/加密合规→加入内部测试组→TestFlight 可见→真实 Watch 安装启动。应用加密声明按最终能力核实，未硬编码 `ITSAppUsesNonExemptEncryption=false`。[Apple 内部测试](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)、[合规信息](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds)
8. **最小真机门槛**：真实 Watch 打开设置，点击读取真实服务响应，记录版本与随机 request_id、构建号、手表系统、测试时间。之后完成真实配对、离线原文、重启补发、响应丢失去重、空间冻结和身份隔离。没有这些记录不能标记 M0B/M1 真机验收通过。

在自己的安全目录复制 `apple/delivery-config.example.json` 为未跟踪的 `apple/delivery-local.json`，填写非秘密配置后运行：

```sh
python scripts/apple-delivery-preflight.py apple/delivery-local.json
```

该命令仅做本地语法检查，不验证 Apple 账号权限、profile 或域名可达性，不读取秘密也不上传。`API_BASE_URL` 必须是 Watch 能访问的有效 HTTPS origin；`127.0.0.1` 是手表自身，不能用来访问 Windows。

### 验证与外部阻塞

本轮自动检查限于静态文件、Python 脚本与共享 hash 向量。可用 `python scripts/apple-tools-test.py` 复现 5 项交付工具测试；其中合成目录只测试检查器能否拒绝缺少 Watch 与版本冲突，不是编译产物证据。另有 15 项 Swift 核心测试已提供但未在 Windows 执行，包含精确配对 URL 路径、非法 ID 请求前拦截，以及无身份字段的撤销/到期响应；没有真实 Apple SDK 构建结论。网络替身仅证明契约与状态机的测试意图；尚需在真实后端和真机运行。

用户最新决定已授权公开新分支与无 Apple Secrets CI，云端构建结果待实际执行记录。其余外部阻塞：本机没有 macOS/Xcode；未确认 Apple Developer/ASC 权限、签名材料和真实 bundle IDs；未配置 Watch 可达 HTTPS 后端；未提供目标手表/iPhone 型号系统；没有 TestFlight 安装反馈。以上仅阻塞相应分发步骤，不阻塞后端、测试和配置说明继续实现。

下一阶段先获得无签名云构建证据并修正任何工程差异，再按实际 profile 映射准备可审查签名方案；获得明确发布授权后才上传。M2 才增加资料问答、简报与有边界的前台任务轮询，不扩大 Watch 装饰性 UI。
