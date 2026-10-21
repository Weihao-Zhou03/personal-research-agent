# Apple Watch 工程与真机分发

核查日期：2026-10-21。**M0A真实云构建已通过，签名、上传和真机安装未完成**。已按最新授权通过GitHub macOS runner执行15项Swift核心测试、Watch模拟器编译、无签名wrapper归档和8项结构检查。本机仍为Windows；Apple账号配置、签名材料、真实HTTPS和目标手表信息尚缺。本文件不以Mock、IPA或模拟器结果代替真机验收。

后续M1/M2客户端在 `196e2c4bd46461ed65bb892f8dfaca3a752efd41` 的[run39567460679](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39567460679)已核对实际日志：23项Swift、Watch模拟器build、无签名archive与8项结构检查均通过。当前配置注入/签名脚本属于此后改动，不能借用该次成功声称新增发布流程已验证。

## M0A 已实现与真实构建证据

- `apple/project.yml`：XcodeGen 2.46.0（提交 `8445e778451c7e44237b90281bde622d764b0084`），明确 Xcode 26.6、watchOS 10.0 Deployment Target 和共享 scheme。
- `ResearchWatch`：现代单 target SwiftUI Watch App；`PersonalResearch`：Apple watch-only 分发所需 iOS wrapper stub，不创建 iPhone 可执行界面。没有旧式 WatchKit Extension 业务 target。
- `scripts/apple-check.sh`：核心测试、无签名 Watch 模拟器 build、无签名 wrapper archive、归档实际产品检查分别执行；不是发布脚本。
- `.github/workflows/watch-check.yml`：macos-26 runner、固定 Xcode 路径，只读仓库权限，无 Apple Secrets；保存日志和检查结果。
- `.github/workflows/watch-testflight.yml`：已补受保护、仅手动的签名/导出/上传流程；默认未授权启用，只接受main上已审查SHA。实际Apple签名、上传、ASC处理与真机均未运行，不能视为M0B通过。

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

wrapper结构同时依据Apple独立Watch文档与[固定版XcodeGen生成器实现](https://github.com/yonaskolb/XcodeGen/blob/2.46.0/Sources/XcodeGenKit/PBXProjGenerator.swift)。现已在真实无签名archive确认Watch App位于wrapper的`Watch`目录、可执行文件存在，版本与bundle关联正确；签名profile映射仍待实际发行配置。

### 运行与复现

在拥有 Xcode 26.6 的 macOS 执行仓库根目录命令：

```sh
bash scripts/apple-check.sh
```

无密钥CI已按用户最新授权推送触发。首轮[run39562283553](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39562283553)暴露Swift泛型函数内嵌类型错误；已作最小修复，第二轮[run39563062510](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39563062510)真实成功，源码`c8e0e32264b709963bd70f4be50449dc609eee98`。实测Xcode26.6/build17F113、Swift6.3.3和watchOS SDK26.5；SDK版本与watchOS10最低部署版本分别记录。

| 证据 | 产生位置 | 目前结果 |
| --- | --- | --- |
| Swift 核心测试 | `apple/Generated/check/swift-test.log` | 15项XCTest通过、0失败 |
| Watch 模拟器 build | `watch-simulator-build.log` | BUILD SUCCEEDED；未做模拟器交互测试 |
| wrapper archive | `unsigned-archive.log` | ARCHIVE SUCCEEDED；无签名 |
| 实际嵌入与 bundle 检查 | `archive-inspection.json` | 8项全部true，含可执行文件与版本 |
| 签名/上传/TestFlight/真机 | 独立发布与人工记录 | 未执行 |

`apple/delivery-manifest.json`列出了已验证结构的target、bundle setting、scheme与archive destination，状态为`unsigned_structure_verified`并绑定源码SHA。当前bundle IDs仍是占位值，发行所需profile按实际Apple配置和签名归档确认，不把数量写死。生成工程不入库，可重复生成。原样结构报告见`docs/ci/watch-archive-39563062510.json`；CI artifact只保留日志/JSON，未上传archive或IPA，详细digest与保留期限见`docs/VERIFICATION.md`。

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

当前只实现前台/手动同步，不作后台实时承诺。配对查询每5秒、最多约1分钟；应用失去前台时不再发起轮询。原文保存不依赖模型。资料问答按后端capabilities.ask开放：问题最多1000码点，与Capture共享100条/1MiB队列，先落盘再提交，获得真实job ID后才显示后端已接收。Watch通过GET只读任务状态与结构化简报，至多3要点、来源数与更新时间；不解析长Markdown，不触发生成。前台5/10/20/20秒退避，并在60秒截止后不再调度；单个在途短请求可能在截止后返回。Feed为每页20项的稳定游标分页；状态/结果缓存仍按身份隔离。

HTTP429的Retry-After支持秒数和HTTP-date；非法或缺失为60秒，最少1秒、上限24小时。同origin/deployment/owner与同操作的截止时间写入outbox journal，所有条目、重启、重新进入前台、手动同步都受同一截止限制，不改变原ID、payload或目标空间。旧journal缺少暂停字段可兼容读取。

## M0B 尽早验证路径

1. **先获得无签名证据**：运行 watch-check，核对 wrapper 下 `Watch/ResearchWatch.app`、可执行文件、独立运行标记、版本与 bundle 关联。若失败，修正最小工程，不暗中增加完整 iPhone companion。
2. **确定非秘密配置**：确认目标 Watch 型号、watchOS、配对 iPhone 系统、Team ID、可用 bundle IDs、实际 HTTPS 域名、ASC 数字应用 ID、Key ID/Issuer ID。真实设备信息尚缺。
3. **用户自行处理账号**：Apple Developer Program、协议、身份验证和任何付费操作由用户明确授权并自行完成；本轮未创建账号资源或付款。
4. **审查 target/profile 映射**：按实际归档 target 注册明确 App IDs，profile 与 Distribution 证书配对。App Store Connect 的 watch-only 记录按 Apple 流程选择 iOS，并不要求完整 companion。[Apple watchOS 记录](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-watchos-app-information)
5. **用户自行录入 Secrets**：Distribution P12/密码、各实际 target 的 provisioning profile、ASC team API P8 放进 GitHub `apple-testflight` 受保护环境，不贴聊天。P8 是上传认证，P12 是签名，不可互换；Issuer ID 不是 Team ID。环境启用 required reviewers。[GitHub 签名流程](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
6. **具体发布审查后再启用上传**：发布脚本现已实现缺项预检（只显示字段名）、临时Keychain、证书有效期/Team/identity/profile核对、ASC真实历史构建号递增核对、签名archive、app-store-connect导出、独立上传与处理等待、finally及workflow always清理。发布任务串行，只运行main历史中的受信任SHA；普通PR与无签名CI不接触Apple Secrets。脚本和受保护工作流尚未执行真实签名验证。
7. **分开记录外部结果**：签名归档→导出→ASC 上传→处理完成/加密合规→加入内部测试组→TestFlight 可见→真实 Watch 安装启动。应用加密声明按最终能力核实，未硬编码 `ITSAppUsesNonExemptEncryption=false`。[Apple 内部测试](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)、[合规信息](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds)
8. **最小真机门槛**：真实 Watch 打开设置，点击读取真实服务响应，记录版本与随机 request_id、构建号、手表系统、测试时间。之后完成真实配对、离线原文、重启补发、响应丢失去重、空间冻结和身份隔离。没有这些记录不能标记 M0B/M1 真机验收通过。

在自己的安全目录复制 `apple/delivery-config.example.json` 为未跟踪的 `apple/delivery-local.json`，填写非秘密配置后运行：

```sh
python scripts/apple-delivery-preflight.py apple/delivery-local.json
```

该命令仅做本地语法检查，不验证 Apple 账号权限、profile 或域名可达性，不读取秘密也不上传。`API_BASE_URL` 必须是 Watch 能访问的有效 HTTPS origin；`127.0.0.1` 是手表自身，不能用来访问 Windows。

### 验证与外部阻塞

本轮除静态检查与Python工具5项外，已真实执行macOS Swift核心15项测试、Watch SDK编译与无签名archive检查。Python的合成目录仍只验证检查器拒绝分支；真实归档证据另行保存。Swift中的URLProtocol是网络替身，验证请求路径、字节和状态机，不能替代真实后端/Watch联调。Keychain、中文系统输入、前后台/断网恢复、真实TLS与设备安装均需后续实测。

公开新分支与无Apple Secrets CI已授权并完成。剩余外部阻塞：未确认Apple Developer/ASC权限、签名材料和真实bundle IDs；未配置Watch可达HTTPS后端；未提供目标手表/iPhone型号系统；没有TestFlight安装反馈。本机没有macOS不再阻塞M0A云构建；后端和配置说明可继续独立实现。

下一阶段获得当前扩展客户端和配置注入的真实云构建证据；配置真实HTTPS诊断，按实际target/profile映射完成签名验证。取得签名分发所需材料和明确授权后才上传，不扩大未通过M0B的Watch装饰性UI。

## 非秘密配置与受保护发布的具体操作

普通CI使用 `apple/ci-config.json`，含 `synthetic:true`，只有无签名配置器显式 `--allow-synthetic` 时接受。发布预检拒绝synthetic、example/invalid占位地址、非HTTPS、回环地址、用户名密码、未知JSON字段、错误类型、换行、shell/xcconfig注入。版本和构建号必须为字符串。构建脚本以xcconfig注入API/team/bundle/version/build；`apple-inspect-archive.py --expected-config` 对归档中的实际两层bundle与Watch API URL做核对，而非只看JSON存在。

```sh
python scripts/apple-configure.py apple/delivery-local.json --output apple/Generated/Build.xcconfig
APPLE_CONFIG_PATH="$PWD/apple/delivery-local.json" APPLE_ALLOW_SYNTHETIC=0 bash scripts/apple-check.sh
python scripts/apple-delivery-preflight.py apple/delivery-local.json
```

发布工作流只有同时满足以下条件才进入签名步骤：从main手动触发；仓库变量 `APPLE_UPLOAD_AUTHORIZED=true` 已经由用户在明确授权后设置；输入两次一致的完整SHA；SHA已在main历史中；GitHub API确实返回 `apple-testflight` 环境存在required reviewers。缺保护规则或无法读取规则即失败。是否禁止自我批准由用户按实际审核人员选择，不强加第二个GitHub账号。普通PR不触发该工作流。环境review gate仍须用户实际配置，本轮没有创建环境、填写Secrets、启用变量或触发发布。

当前实现集中在待审PR，**本轮不会自动合并**。上述main门禁意味着不能直接拿当前PR分支运行签名发布，也不会为绕过门禁修改工作流。未来顺序为：用户审查并决定合并 → 自行完成Apple与HTTPS配置 → 对已审查main SHA运行真实配置无签名检查 → 用户另行明确授权该SHA签名上传 → 手动触发并批准受保护环境。本轮完成代码和无密钥验证，不代表已经获得未来上传授权。

非秘密variables为示例JSON字段（另加可选 `ASC_INTERNAL_TEST_GROUP_ID`）。`CURRENT_PROJECT_VERSION` 由本次手动输入，脚本在上传前核对ASC应用bundle和已有build，拒绝重复/降低；不能比较的历史或过多分页会停止，不猜测可用构建号。发布串行且 `manageAppVersionAndBuildNumber=false`，Xcode不自行改号。

用户仅在受保护GitHub环境录入四项Secrets：`APPLE_DISTRIBUTION_P12_BASE64`、`APPLE_DISTRIBUTION_P12_PASSWORD`、`ASC_API_PRIVATE_KEY_BASE64`、`APPLE_PROFILES_BASE64_JSON`。最后一项是JSON对象，**key为实际bundle ID、value为该App Store profile的Base64**；按交付manifest实际target动态匹配，不把profile数量写死。不要把内容贴聊天或提交仓库。P8必须是所述ASC team API key，不能替代P12签名。

`scripts/apple-release.py` 在配置、受信任SHA及显式授权验证后执行同配置无签名检查，再导入P12到临时Keychain，检查证书未来24小时有效、Team和有效codesigning identity；每份profile核对有效期、App ID、Team、distribution权限和实际证书指纹。临时Keychain密码在job内随机产生，非交互私钥权限按GitHub官方流程设置。Keychain、安装profiles与临时私钥目录有finally清理，workflow另有always回退清理；回退只接受本run临时目录与UUID命名的安装profile，拒绝越界路径。

真实构建前会检查所选Xcode `-help` 是否支持 `app-store-connect` 与API key认证选项；帮助文本合并stdout/stderr读取。无Secrets CI也执行该真实工具探测，将通道字节数和支持标志保存为 `xcode-tool-support.json`，避免把stderr输出误判为不支持。先 `destination=export` 独立产生IPA，再 `destination=upload` 上传相同archive。未使用Apple已标弃用的 `altool --upload-app`，不未经核实写加密豁免声明。[Apple上传工具说明](https://help.apple.com/asc/appsaltool/en.lproj/static.html)

上传成功仍会通过ASC API最多等待约15分钟确认processingState=VALID，必要时按显式内部组ID分配build。上传前及加组前均GET核对组ID、isInternalGroup=true、所属App一致且未开启公开链接，拒绝外部组或跨App目标。处理失败/超时不会伪报TestFlight可安装，也不会自动换号重传；在ASC先核对已接收构建。report在签名、导出、开始上传、接受及处理成功时逐步原子落盘：在途失败保留 `upload_state=submission_unknown`、`uploaded=null`，不能当成“没有上传”盲目重试。最终report仍将compliance、TestFlight可见性与真实手表安装列为另行验证，用户需在ASC处理Missing Compliance并实际安装。[ASC构建状态](https://developer.apple.com/documentation/appstoreconnectapi/build/attributes-data.dictionary)、[内部组属性](https://developer.apple.com/documentation/appstoreconnectapi/betagroup/attributes-data.dictionary)、[内部组关联接口](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups-_id_-relationships-builds)

本次新增交付工具17项在Windows实测通过，覆盖配置注入拒绝、合成fixture门禁、预期归档不匹配、profile日期/Team/bundle/证书拒绝、JOSE签名格式、清理路径边界、stderr帮助、内部组归属/外部组拒绝、处理中与失败区分、上传未知journal。它们使用合成数据，不代表真实Apple签名或ASC服务通过。Swift客户端23项已在上述196e2c4真实云构建中通过；配置注入改动需要后续对应SHA的新结果。
