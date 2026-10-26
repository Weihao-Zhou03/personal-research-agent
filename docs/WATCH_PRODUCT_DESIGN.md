# Personal Research Agent 与 Apple Watch 完整设计方案

版本：1.0  
日期：2026-10-21  
用途：供本地 Codex 在现有仓库中分阶段实施、验证和交接。  
代码基线：Weihao-Zhou03/personal-research-agent，提交 f871d18c313ee91c09874f3efe13b3c321a8cf84。  
本文件是目标设计，不表示其中功能已经实现。

## 1 设计决策与完成标准

产品定位：一个以个人研究资料为依据的助手。用户在 Apple Watch 上随手记下想法、向自己的资料提问、查看简短结果；在电脑或手机网页上导入资料、阅读证据和完整结果、确认知识归档。

首版面向一个拥有者及其设备。目标是每天可以使用的个人工具，保留未来扩展能力，不建设多租户商业平台。

| 决策 | 首版选择 |
| --- | --- |
| Watch 是否部署语言模型 | 不部署 |
| 生成模型 | 后端调用一个明确配置的云端模型接口 |
| 现有 Ollama | 保留为兼容的高级选项，暂停功能扩展，不默认安装 |
| 资料检索 | 必做；先做适合中文的词法检索与来源追踪 |
| Embedding | 后续按评测决定，不作为首版启动依赖 |
| Watch 应用 | 原生 SwiftUI，首选 watch-only |
| iPhone 应用 | 首版不另做完整 companion；确有分发阻塞时再评估极简 companion |
| 语音输入 | 使用系统文本输入提供的听写等方式，不自建 ASR |
| 长任务 | 后端执行并持久化；Watch 不需要保持连接 |
| 数据库 | 单机 SQLite，原始数据和任务状态持久化 |
| 现有项目 | 渐进改造 Node 服务与 Web，不整仓重写 |
| 编译与安装 | GitHub Actions macOS runner → App Store Connect → TestFlight → 真机 |
| 无资料的问题 | 返回资料不足，不自动转成互联网搜索或自由发挥 |
| 首版交付 | 可装到目标手表、连接真实后端、可靠记录与资料问答，并有真实验收记录 |

完整交付需要同时满足三件事：真实手表可安装；操作在断网、退出 App、后端重启等情况下不会无声丢失；回答能追溯到实际资料。模拟器截图、Mock 数据、CI 编译成功不能替代这些条件。

### 1.1 默认假设与实施前检查

现在可以按以下假设开发，不必为了未知信息暂停所有工作：

- 单用户，自托管或自己控制的后端。
- 用户使用 Windows 开发，没有本地 Mac。
- 有一块目标 Apple Watch，以及可用于 TestFlight 安装管理的配对 iPhone。
- Watch 最低部署版本暂定 watchOS 10.0；到真机阶段核对具体型号、watchOS、配对 iPhone 系统和所选 Xcode 的支持范围。
- 先用中文界面，正确处理中文和中英混合资料。
- 模型供应商、后端域名、Apple Team ID 等通过配置提供，不硬编码个人账号资料。
- 用户可以暂时未开通付费开发者账号。此时先完成无签名构建与后端功能，将真机分发标记为未完成。

SDK 版本、Deployment Target 和真机系统版本是三件不同的事。用新 SDK 构建不代表手表必须升级到同名系统；最终仍要在目标真机验证兼容性。[S1][S2]

## 2 现有项目基线与保留内容

已检查的代码包含真实的 Node HTTP 服务、中文网页、三种处理模式、ThinkFlow 资料读取与人工确认后的写回。现有自动测试 30 项曾在当前检查环境通过；模型及部分上游服务在测试中使用替身，这不等于新 Watch 功能或真实模型质量已经通过验收。

| 现有文件 | 当前职责与边界 | 改造方向 |
| --- | --- | --- |
| server.mjs | 本机 HTTP、JSON 状态、内存队列、管理接口；监听回环地址 | 保留组装入口，逐步拆出存储、认证、任务、设备接口 |
| lib/processor.mjs | 规则摘录、Ollama 选句、云模型整理与追问 | 保留旧接口；新增基于检索证据的结构化回答 |
| lib/thinkflow.mjs | 核对笔记本和资料归属、正文快照、hash、写回与回读 | 保留适配器，新增同步层与写回核对状态 |
| lib/proxy-config.mjs | 读取特定 Windows 桌面路径的本机代理配置 | 仅作本机可选兼容；生产环境使用显式模型配置 |
| public/app.js 等 | 资料选择、长文编辑、人工确认、知识库、设置 | 保留主体，增加空间、配对、同步、任务详情 |
| scripts/start.ps1 等 | Windows 启停和依赖安装 | 保持可用；不因默认云模型而启动或下载本地模型 |
| data/workspace.json | 旧业务数据 | 显式迁移至 SQLite，保留原文件和回退依据 |
| .github/workflows | 检查基线中不存在 Watch 构建流程 | 新增后端检查、无签名 Watch 检查、受控分发流程 |
| 原生 Apple 工程 | 检查基线中不存在 | 新增独立目录，先完成最小可分发工程 |

当前 Ollama 分支不是一般生成式问答：它让模型返回原句编号，程序最多选择六段原文。更换为更大的本地模型不会自动改变这一行为。当前云模型分支读取整份给定材料，尚未实现本方案的工作区检索和结构化引用验证。[R1][R2][R3]

以下行为必须保留：

- 材料正文和任务指令分离，资料不得成为执行系统指令的渠道。
- 来源归属、正文 hash、读取快照可以追溯。
- AI 输出经人工确认后才进入正式归档或 ThinkFlow 写回。
- 凭据不进入任务导出、结果或日志。
- 外部写回后核对真实正文；冲突不得被标成成功。
- 取消操作不能被晚到的模型响应覆盖。
- 历史任务原有的保守恢复语义不能被静默更改。

实施时先读取本地 AGENTS.md、git status、当前 HEAD 和已有文档。若本地代码已超出基线，比较差异并调整文件映射；不要 reset、清空或覆盖用户未提交的工作。

## 3 产品范围

### 3.1 首版必须完成的三个使用场景

**记灵感**

用户在 Watch 输入一段原始笔记，确认文字和目标空间后保存。先持久化到手表，再发送至服务器。服务器原文保存不依赖模型、embedding、ThinkFlow 在线状态或索引成功。

例如：“以后对比这两篇论文的评测数据集，重点看中文任务。”

这条笔记是用户原始内容，不是经过核验的研究事实。系统可在后续索引它，并在引用时标为个人笔记。不得为了生成标题而额外调用模型。

**问资料**

用户问：“我保存的资料里，这两种方法最大的区别是什么？”后端在指定空间的已导入资料中检索，冻结证据，再生成有来源的回答。

不要求用户在手表选择十份文件或粘贴全文。默认空间和可查询来源在 Web 设置；手表提交前显示空间名称。

**看简报**

查看最近任务的状态和已经生成的简短结果。这里的“简报”是已有任务结果的短展示，不是定时生成新闻日报。刷新、打开列表、查看缓存均不得触发新模型调用。

### 3.2 Web 承担的工作

- 创建和命名研究空间，设置设备默认空间。
- 粘贴文本、导入 TXT/Markdown；复用 ThinkFlow 已有资料读取能力。
- 从 ThinkFlow 选择笔记本及资料，查看同步与索引状态。
- 阅读完整回答，展开原始证据、来源版本、读取时间。
- 编辑结果、确认归档、检查 ThinkFlow 写回状态。
- 配对或撤销设备，查看任务失败和用量。
- 导出、备份和恢复数据。

首版不新增扫描 PDF OCR、通用网页抓取或复杂 Office 文档解析。ThinkFlow 已能读取的文本层 PDF 可以继续使用；没有正文时明确报告，不能把登记 URL 当成已阅读网页。

### 3.3 后续扩展

在首版验收后，可依次考虑：

1. 云端 embedding 与词法检索融合，按真实问题的召回提升决定是否启用。
2. APNs 完成提醒、表盘入口、Smart Stack。
3. 有上下文的短追问、手机接力阅读。
4. 受控的互联网检索与网页读取。
5. 有实际隐私或离线后端需求时，再扩展本地生成模型。
6. 面向公开发布时，补充完整表端认证与商店提交要求。

首版不做常驻监听、连续语音对话、表端 LLM、多 Agent 编排、知识图谱、微服务、专用向量数据库或每日自动研究。

## 4 系统架构与运行位置

~~~mermaid
flowchart TD
    W["Apple Watch"] -->|短请求与状态查询| A["HTTPS API 与权限检查"]
    U["电脑或手机 Web"] -->|资料管理与人工确认| A
    A --> D["SQLite 与资料快照"]
    J["持久任务执行器"] <--> D
    J --> R["资料检索与引用验证"]
    R <--> D
    J --> M["云模型接口"]
    J --> T["ThinkFlow 适配器"]
~~~

### 4.1 运行责任

| 部分 | 运行位置 | 责任 |
| --- | --- | --- |
| Watch 客户端 | Apple Watch | 输入、待发送队列、状态、简报缓存 |
| Web | 电脑或手机浏览器 | 资料管理、审阅、配对、设置 |
| API 与执行器 | Windows 原型机或常开服务器 | 认证、持久任务、检索、调用模型 |
| SQLite 与快照 | 后端持久磁盘 | 业务事实、证据、用量、写回记录 |
| 云模型 | 配置的供应商服务 | 根据提供的证据生成结构化回答 |
| ThinkFlow | 后端同机的受限服务，或早期 Windows 本机 | 可选的资料来源与确认后归档目标 |
| GitHub macOS runner | 每次构建时临时运行 | 编译、签名、导出、上传；不托管日常后端 |

“后端运行在自己的电脑上”和“使用本地语言模型”互不等同。后端可以在 Windows 上管理资料，同时调用云模型。电脑关机时，即使模型供应商在线，Watch 也无法访问这台电脑上的任务和资料。

### 4.2 部署模式

本机模式保留回环地址与 Host/Origin 限制，继续支持原有工作流。

服务器模式必须显式开启，要求配置公开 HTTPS 地址、管理员认证、设备认证和持久数据目录。模型配置决定 Ask 能力是否就绪，不作为 Capture 或整个服务启动的前提。未配置模型时，Capture 正常可用，Ask 返回 MODEL_NOT_CONFIGURED。不能只把监听地址改成 0.0.0.0。

旧的全量 /api/state、/api/export、模型设置及任意 ThinkFlow 管理接口不能通过设备权限访问。服务器模式只注册经过认证和权限检查的新路由；旧本机路由保留在本机模式中。

移动 Web 使用管理员登录会话；Watch 使用单独的设备凭据。两者权限分开，不把管理员会话复制到手表。

## 5 Watch 交互与本地状态

### 5.1 页面

| 页面 | 内容 | 必须处理的状态 |
| --- | --- | --- |
| 首次连接 | 连接说明、短配对码、有效期、批准网址 | 无网、过期、等待批准、被拒绝 |
| 首页 | 当前空间、记灵感、问资料、看简报、待发送数量 | 未选空间、身份失效 |
| 输入确认 | 系统输入后的文字、空间名称、确认按钮 | 空文本、过长、取消 |
| 最近任务 | 最近 20 项的轻量信息，分页；待发送项单列 | 加载、无任务、缓存、服务不可达 |
| 结果 | 短标题、至多 3 个要点、来源数、更新时间 | 完成、资料不足、失败、待核对 |
| 设置 | 连接状态、默认空间、同步、重新配对、清理缓存 | 凭据过期、撤销、未上传内容 |

正常页面不展示模型参数、数据库、GitHub 构建等实现细节。完整报告在 Web 的同一任务详情中阅读；首版不承诺按钮可以自动在 iPhone 打开，除非真正实现并验证接力能力。

文本输入优先使用系统界面。听写、键盘等可用方式取决于机型、系统、语言和网络；不承诺所有手表都支持中文离线听写。用户可以在提交前核对文本。[S3]

### 5.2 待发送队列

每次用户确认保存或提问时，先原子持久化一个队列项，再尝试联网。使用 Application Support 中的应用自有文件或数据库，不用可被系统清理的缓存目录，不只放内存。

最低字段：

~~~json
{
  "client_request_id": "客户端生成的 UUID",
  "operation": "capture",
  "workspace_id": "ws_example",
  "workspace_name_at_creation": "论文阅读",
  "backend_origin": "https://agent.example.com",
  "deployment_id": "部署实例标识",
  "owner_id": "已配对拥有者标识",
  "text": "用户确认的原文",
  "created_at_client": "ISO 8601 时间",
  "state": "pending",
  "server_resource_id": null,
  "last_error_code": null
}
~~~

必须遵守：

- 同一操作的传输重试、超时重传、App 重启补发都使用同一 client_request_id。
- 队列保存完整的首次提交 payload；重传不重新生成客户端时间，也不重新做会改变正文的规范化。
- 用户修改内容或主动重新研究时创建新 ID。
- 队列项保存创建时的空间；默认空间后来改变，旧项仍发往原空间。
- 原空间被删除或权限撤销，保留原文并显示待处理，不能自动改投其他空间。
- 凭据到期、解除连接或重新配对，不自动删除未上传内容。
- 更换后端或拥有者时，旧队列冻结；只有确认仍为同一部署和拥有者才可恢复自动发送。
- 最近任务与结果缓存同样按 backend_origin、deployment_id、owner_id 分区；切换身份后不显示或合并旧身份缓存。相同身份重新配对可复用缓存；清理缓存不删除 outbox。
- 首版队列容量 100 条、总文本上限 1 MiB；达到上限时拒绝新增并说明，不覆盖旧内容。
- 未获服务器确认的原文不得自动清理。收到资源 ID 后先持久化确认，再从 outbox 移除或转为已同步记录；已同步缓存可以按保留策略清理，不占用待发送容量。
- 用户只能直接取消从未发起过传输的条目。已经开始 POST 但没有收到确定响应的条目标为 submission_unknown，显示“提交结果待确认”，使用同一 ID 重试核对，不能仅因缺少服务器 ID 就当作未发送。

服务器确认前文案为“已保存在手表，待上传”；确认后为“已保存到资料库”。索引是否完成是另一个状态，Web 可见。

### 5.3 网络与前后台

首版的保证是：打开 App 或点同步时，尝试发送待处理内容并更新结果。不保证 App 关闭后只要恢复网络就立即上传。

使用 URLSession 发短请求；提交目标在数秒内返回资源 ID。任务列表前台按 5 秒、10 秒、20 秒退避更新，最多自动刷新约 1 分钟，之后提示稍后查看或手动刷新。失去前台时停止普通轮询，取消本地请求不等于取消服务器任务。

Watch 应用通常只有较短的前台运行时间，普通前台请求不应承载完整模型生成。后台传输可以后续优化，但不得作为正确性依赖。[S4][S5]

首版只在 Watch 提供“取消尚未发起传输的项目”。对 submission_unknown 先核对是否已接收；本地丢弃不能撤销已经到达服务器的操作。远程取消仍可由后端和 Web 支持；未实现完整远程取消状态前，Watch 不展示会误导用户的“停止研究”。

## 6 认证与设备配对

### 6.1 管理员登录

单用户部署不需要先做注册系统。提供本地初始化命令，让拥有者设置管理员密码；服务器只保存加盐的密码校验值，使用 Node crypto.scrypt 等合适的密码派生方法。

Web 会话使用 HttpOnly、Secure、SameSite cookie。写操作检查 CSRF token 和允许的 Origin；登录、配对批准接口限速。凭据、密码和完整模型错误 body 不进入日志。

公开地址没有正确配置管理员身份时，服务器模式启动失败，不进入“临时无密码”状态。

### 6.2 Watch 配对协议

为避免在手表输入长 token，也避免“凭据兑换响应丢失后无法恢复”，采用设备先生成凭据、服务器批准后激活的方式。

1. Watch 生成 32 字节的密码学随机数据，编码为不带填充的 Base64URL 字符串 device_secret；另生成 pairing_request_id，先写入 Keychain。
2. 通过 HTTPS 提交 pairing_request_id、SHA-256(UTF-8(device_secret)) 的小写十六进制值、设备显示名。Swift 与 Node 必须使用同一编码规则和共享测试向量。
3. 服务器建立 pending 设备记录，返回 8 位易辨认短码、10 分钟有效期及批准网址。
4. 用户在已登录 Web 输入短码，核对设备名和请求时间，选择允许空间并批准。
5. Watch 在前台用 device_secret 作为 Bearer 凭据查询本次配对状态，默认间隔 5 秒。
6. 服务器比较凭据 hash，只有批准后才允许业务接口；批准结果包括 owner_id、deployment_id、默认空间和到期时间。
7. 该 device_secret 成为本设备的可撤销凭据。服务器始终只存其 hash，不返回模型密钥，也不依赖一次性明文 token 响应。

这是本项目的简化设备配对协议，不宣称实现 OAuth 标准。

约束：

- 短码只用于人工识别与批准，不能单独兑换访问权限。
- 同一 pairing_request_id 和相同内容重复提交返回同一会话；不同内容返回 409。
- 为了响应丢失后能重现同一个短码，允许在有效期内保存短码原值；到期清理，不输出到日志。它与始终只保存 hash 的永久 device_secret 不同。已过期请求重放返回过期状态，不能复活旧配对。
- 未批准凭据只可访问自己的配对状态，不能读任务或资料。
- 配对码到期、被拒绝或取消后不能激活；限制创建频率和猜码次数。
- 设备 token 默认 90 天有效，到期重新配对；Web 可立即撤销。
- token hash 在设备表唯一；配对批准、拒绝与过期转换使用事务条件更新。批准一次后重放不能改变拥有者、scope 或空间。
- 凭据存 Keychain，首版只承诺前台同步，使用适合解锁访问的可用性策略。
- 待批准凭据和当前有效凭据分开保存。批准成功并持久化身份信息后再切换 active credential；新配对失败或取消不破坏仍有效的旧连接。
- 全部设备 API 均检查有效期、撤销状态、操作 scope 和 workspace_id。
- 撤销设备不自动删除它之前已合法提交的任务；后端可继续为拥有者完成任务，但该设备不能再读取结果。
- 不记录 Authorization、device_secret 或原始配对请求敏感字段。

首次设置需要另一块屏幕打开已登录 Web。这是个人 TestFlight 原型的明确取舍。Apple 对面向用户的独立 Watch 应用有表端账号创建和登录的体验要求；公开发布前重新评估完整认证方案，不能把本方案直接当作已满足所有商店要求。[S6]

## 7 资料同步与检索

### 7.1 研究空间

workspace 是本应用稳定的空间 ID，可关联一个 ThinkFlow 笔记本，也可以只有本地导入内容。不要直接把 ThinkFlow notebook_id 当作所有客户端的唯一业务 ID。

一个空间包含：

- 用户导入的原始资料。
- 用户明确保存的个人笔记。
- 可选的 ThinkFlow 来源。
- 当前可检索语料版本 corpus_revision_id。
- 资料与索引状态、最近成功同步时间。

AI 生成结果作为派生内容保存，默认不回灌到原始证据索引。用户确认归档也不自动使它成为独立事实来源；如以后允许检索，须保留 derived 类型与其来源链。

### 7.2 同步与快照

同步流程：

1. 从已配置来源读取有效资料列表，核对笔记本归属。
2. 逐份读取实际正文，记录 source_id、来源类型、读取时间、正文 SHA-256。
3. 内容未变化时复用快照；变化时生成不可变 source_version。
4. 对新快照切块并建立检索索引。
5. 全部拟发布条目准备好后，事务性发布新的 corpus revision。
6. 旧任务继续引用自己的版本，后来的同步不改变已生成答案的证据。

多份资料是逐份读取的，记录各自读取时间，不声称它们来自同一个原子上游时点。

来源列表获取失败时保留上次成功索引，显示同步失败；不能把全库当作已删除。来源成功确认删除后，从新语料版本中排除，但仍按保留政策保存被历史答案引用的快照。

ThinkFlow 的不可达不应使已经同步的资料无法查询。查询页说明使用最近成功同步的快照。ThinkFlow 原生写回另行排队和显示状态。

### 7.3 中文检索基线

首版实现以下完整路径，而不是把全部资料一次塞给模型：

- 按段落、句子切块；目标 600–1,000 个 Unicode code point，重叠约 80–120，保留章节标题。
- 表格、公式段尽量保持整体；过长段落按明确规则拆分并保留位置。
- 使用统一、版本化的中文和英文分词流程，例如 Intl.Segmenter 的 word 粒度。
- 索引独立的预分词 token 列，原始正文完全保留。
- SQLite FTS5/BM25 查询预分词列；输入必须被转义和参数化，不把用户文字当 FTS 表达式执行。
- 中文短词、英文缩写和未切出的术语提供限定空间内的精确子串补召回。
- 先限制到被授权空间及冻结语料版本，再进行 Top K；不能全库取 Top K 后才过滤。
- 初步取 20 个候选，去重、适度扩展相邻块，每份来源最多占最终证据的约一半。
- 最终最多 8 块证据，总上下文预算另行限制；记录每个入选块及排序依据。

SQLite 的 unicode61 不是中文分词器；trigram 的全文匹配不能覆盖少于 3 个 Unicode 字符的查询。因此不能只配置一个默认 tokenizer 就把“模型”“研究”“AI”的召回视为完成。[S7]

所有数字是可配置初始值，必须用真实中英文问题评测。检索分数不是置信概率，不把 BM25 分数显示为“90% 准确”。

### 7.4 Embedding 扩展接口

预留 embedDocuments 和 embedQuery 适配接口，但首版不要求用户配置 embedding 服务。后续启用时：

- 单独记录 provider、model、维度和模型版本。
- 文档与问题使用兼容的向量空间，不混用不同模型。
- 只给改变的 chunk 重新计算；模型变更触发完整重建。
- 词法与向量结果用明确的方法融合，并与词法基线比较。
- 小规模先在现有存储中管理向量，不为功能名称额外建设向量数据库。
- 云端 embedding 也会发送资料内容；不能称其为“资料完全不出本机”。

## 8 模型调用与回答契约

### 8.1 模型选择

新 Ask 默认使用配置的云端生成模型。保留现有兼容接口，不假设任意 OpenAI-compatible 服务都支持同样的 JSON Schema、usage、store、最大输出参数或 embeddings。

设置页分别提供：

- 连接检查：只验证服务和模型可访问，不等于生成质量通过。
- 显式生成检查：用不含私人资料的固定小样本检查真实生成、结构化输出和 usage；会发生一次真实调用。

provider/model/base URL 由管理员配置，Watch 不可更改。首次提交 Ask 时冻结非秘密模型配置版本、提示词版本和预算；密钥只在执行时由服务器配置解析。

当前 Windows 桌面代理不是生产部署的隐含依赖。部署到常开服务器时必须提供该服务器实际可用的模型接口与凭据；不要复制个人代理登录状态并假定能运行。

### 8.2 执行流程

收到 Ask 后，持久化问题、空间和当前语料版本，快速返回任务 ID。执行器：

1. 校验冻结的资料范围和模型配置是否仍可使用。
2. 检索证据并冻结 evidence manifest。
3. 无可用正文时直接返回资料不足，不调用模型。
4. 根据证据、问题和输出 schema 生成结构化结果。
5. 验证结构、长度、引用和必要字段。
6. 如格式或引用错误，在总调用预算内最多修复一次。
7. 仍失败则返回可见错误；不能把无效结果包装成成功。
8. 成功后保存结构化结果与完整报告版本。

首版不把模型接到任意工具执行器、shell、文件系统或不受约束的 URL 请求。资料里的“忽略前面指令”等内容始终作为资料文本。

### 8.3 输出结构

模型返回的引用只能使用本次 evidence manifest 中的 ID。来源标题、URL、快照标识和引文详情由服务器补齐，不信任模型自编书目信息。

~~~json
{
  "schema_version": "1",
  "answer_status": "answered",
  "watch_brief": {
    "headline": "两种方法的主要区别",
    "bullets": [
      {
        "text": "这里是一个由材料支持的简短结论",
        "citation_ids": ["E1", "E3"]
      }
    ]
  },
  "sections": [
    {
      "heading": "依据与解释",
      "statements": [
        {
          "kind": "fact",
          "text": "这里是完整解释",
          "citation_ids": ["E1"]
        },
        {
          "kind": "suggestion",
          "text": "这里是明确标注的下一步建议",
          "citation_ids": []
        }
      ]
    }
  ],
  "limitations": [
    "现有材料没有提供同一评测条件下的结果"
  ]
}
~~~

answer_status 允许 answered、insufficient_evidence、needs_clarification。后两者可以是正常完成结果，不应被统计为网络故障。

输出硬性校验条件：

- watch_brief.headline 不超过 40 个 code point。
- bullets 最多 3 条，每条不超过 80 个 code point。
- answered 至少有一个非空结论；Watch bullets 只展示有证据的结论，每条必须含有效且非空的 citation_ids。建议放到完整报告的 suggestion statement，不混入 Watch 事实要点。
- insufficient_evidence 与 needs_clarification 可使用空引用的缺口或澄清提示，但不能借此输出无依据的实体事实。
- sections 最多 5 节，每节最多 4 条 statement。
- 事实与由资料推得的结论必须关联证据；建议明确标记。
- 长度校验区分 Unicode 字符和 UTF-8 字节，不使用含糊的“字数”。
- Web 根据验证后的结构渲染报告，避免让 Watch 解析长 Markdown。
- Brief 与完整报告一次生成；首版不再调用一个模型给结果做第二次总结。
- 生成达到输出上限或 JSON 不完整时不能当作正常成功。

### 8.4 引用验证边界

程序必须检查：

- 引用 ID 确实属于本次提供给模型的证据。
- 引用来自有权限的空间和冻结版本。
- 对应 source_version 与 chunk 存在。
- 标成“原文”的引文片段由服务器按 evidence manifest 和快照位置直接取出，不把模型自由生成的 text 当成已核验逐字引文。
- Watch 和 Web 的引用映射一致。

有效引用编号不等于结论受到资料支持。支持度、遗漏关键条件、跨来源比较是否合理仍需评测和人工核对。不要在界面或项目介绍中宣称“彻底消除幻觉”。

### 8.5 成本与超时初始配置

| 项目 | 默认值或规则 |
| --- | --- |
| Capture 模型调用 | 0 次 |
| 最近任务和结果读取 | 0 次 |
| Ask 输入 | 最多 1,000 个 code point |
| Capture 输入 | 最多 4,000 个 code point |
| Watch 写请求 body | 最多 32 KiB UTF-8 |
| 每次 Ask 的生成调用总数 | 最多 2 次，包含格式修复和任何重试 |
| 生成输入预算 | 8,000 tokens 起步；按模型真实 tokenizer 或保守上界检查 |
| 生成输出预算 | 约 2,500 tokens 起步，按供应商支持参数配置 |
| 单次生成网络超时 | 90 秒 |
| 默认执行并发 | 1 |
| 每日 Ask 上限 | 50 次，可由拥有者调整 |
| 费用记录 | 真实 usage；缺失写 unknown，不写 0 |

以上是初始产品预算，不是实测性能或费用承诺。若供应商没有可靠 tokenizer，不能用“字符数除以 4”保证中文不超预算；使用保守策略并让超限成为可见错误。

每次调用发出前持久化尝试记录并占用调用预算。超时或进程中断可能已经在供应商侧产生费用；没有响应不意味着没有计费。价格配置版本与历史 usage 分开保存。

## 9 API 契约

设备接口统一以 /api/v1/watch 为前缀；管理员接口以 /api/v1/owner 为前缀；配对接口独立。所有生产请求使用 HTTPS。

资源 ID 使用不可预测的服务端 ID；权限检查不能只依赖 ID 难猜。时间使用 UTC ISO 8601，服务器时间为状态排序依据。

### 9.1 设备接口

| 方法与路径 | 行为 |
| --- | --- |
| POST /api/v1/pairings | 建立或重放幂等的待批准设备请求 |
| GET /api/v1/pairings/{id} | 用待批准设备凭据查询自己的配对状态 |
| GET /api/v1/watch/me | 设备、拥有者、部署标识、默认及允许空间、API 能力 |
| POST /api/v1/watch/captures | 原文事务性保存，返回 201 和 capture_id |
| POST /api/v1/watch/asks | 持久化任务，返回 202 和 job_id |
| GET /api/v1/watch/jobs/{id} | 轻量状态、阶段、错误码、简报是否就绪 |
| GET /api/v1/watch/jobs/{id}/brief | 已生成短结果；不触发生成 |
| GET /api/v1/watch/feed?cursor=... | 最近记录与任务，默认 20、最多 50，稳定游标分页 |

Watch 的 API_BASE_URL 来自构建配置，正常配对过程中不接收任意服务器重定向。设备未确认后端身份前，不自动发送旧队列。brief 未就绪时返回明确的未就绪状态或 202，不使用空结果伪装完成。

GET 结果中不包含 API Key、全量 sourceText、全部历史会话或管理员配置。设备只能查询仍在授权范围内的资源。

### 9.2 提交示例

~~~http
POST /api/v1/watch/asks
Authorization: Bearer <device_secret>
Idempotency-Key: <client_request_id>
Content-Type: application/json
~~~

~~~json
{
  "workspace_id": "ws_example",
  "question": "这两种方法的主要区别是什么？",
  "created_at_client": "2026-10-21T09:00:00Z"
}
~~~

~~~json
{
  "schema_version": "1",
  "job_id": "job_example",
  "status": "queued",
  "workspace_id": "ws_example",
  "corpus_revision_id": "corpus_example",
  "accepted_at": "2026-10-21T09:00:01Z",
  "poll_after_seconds": 5
}
~~~

Capture 同样使用 Idempotency-Key，body 为 workspace_id、text、created_at_client。保存原文与建立索引任务的意图在同一事务中完成；索引任务随后失败不能撤销原文保存。

### 9.3 幂等与错误

- 幂等唯一约束为 owner_id、operation、client_request_id。不能只用当前 token 或 device_id，否则重新配对后补发可能重复。
- 规范化后请求 hash 相同：返回同一个资源 ID，不新增任务、不再次扣减每日任务额度。
- 同键不同 hash：409 IDEMPOTENCY_CONFLICT。
- 先查已存在的幂等记录再做新任务额度判断；重复查询既有任务不能因额度用尽而失败。
- 幂等操作与业务资源写入在同一数据库事务中提交。
- 已接收资源的幂等标识持续保留；删除业务内容时保留不含正文的必要 tombstone，防止晚到重传再次创建。

统一错误 envelope：

~~~json
{
  "error": {
    "code": "WORKSPACE_UNAVAILABLE",
    "message": "原研究空间不可用，内容仍保存在手表",
    "retryable": false,
    "request_id": "req_example"
  }
}
~~~

至少区分 401 凭据失效、403 无权限、404 资源不存在、409 冲突、413 请求过大、422 输入或配置问题、429 限流、503 暂不可用。暂时故障附 Retry-After；上游 body 不直接返回客户端。

### 9.4 管理端接口范围

至少提供空间管理、资料导入和同步、配对批准与撤销、完整任务结果、原始证据查看、编辑与确认、备份、用量和失败诊断。

编辑结果或确认归档时携带 result_revision / expected_content_hash；结果已改变则返回冲突并要求重新审阅。不能把“用户确认旧内容”应用到另一个新版本上。

新增接口契约写入 docs/API_CONTRACT.md 或 OpenAPI 文件，并提供 Watch 与 Node 共用的 JSON fixtures。共享的是契约和样例，不是强迫两种语言共享运行时代码。

## 10 数据模型与持久任务

### 10.1 存储

推荐 Node 24 的固定、实际验证过的补丁版本，沿用 ES Modules；默认封装 node:sqlite，避免引入整个 ORM。

Node 官方当前文档把该模块列为 Release candidate，DatabaseSync 为同步 API。必须锁定运行时、检查实际 SQLite 版本和 FTS5 能力，把查询保持短小，不能把数据库写入伪装成异步后台操作。[S8]

SQLite 放后端同机持久磁盘。启用 foreign_keys、适当 busy timeout，采用经验证的事务与备份策略。若启用 WAL，核对使用版本的修复情况；WAL 不用于多个主机共享的网络盘。[S9][S10]

### 10.2 最小逻辑表

允许把低频嵌套字段存 JSON，避免为了范式堆砌表；下列职责不能丢失。

| 表或实体 | 必要内容 |
| --- | --- |
| app_meta | schema、迁移来源 hash、deployment_id、索引与配置版本 |
| workspaces | 名称、默认设置、ThinkFlow 绑定、当前语料版本、状态 |
| devices | token hash、scope、允许空间、默认空间、到期/撤销时间 |
| pairing_sessions | 请求 ID、有效期内的短码与查找信息、设备关联、到期、批准/拒绝状态 |
| idempotency_records | owner、操作、请求 ID、body hash、资源 ID、删除 tombstone |
| captures | 原始内容、空间、来源设备、客户端与服务器时间、索引状态 |
| tasks | 保留旧任务内容、kind、结果修订、历史追问、ThinkFlow 兼容信息 |
| jobs | 操作、状态、冻结输入、任务关联、模型/语料版本、预算、lease |
| job_attempts | 每次尝试、请求发出标记、provider、usage、结果是否未知 |
| job_events | 顺序号、任务 ID、真实阶段与简短诊断 |
| sources | 来源身份、类型、归属、当前版本、同步/删除状态 |
| source_versions | 不可变正文、hash、实际读取时间、解析信息 |
| chunks 与 FTS 索引 | 快照、原文位置、原文、检索 token、index_version |
| corpus_revisions | 某次发布的可查询 source_version ID 清单 |
| job_evidence | 某任务实际提供给模型的 chunk 与来源映射 |
| results / knowledge_entries | 验证后的结构化结果、人工编辑修订、旧知识条目 |
| writeback_intents | 确认内容、hash、目标、上游标记、核对与冲突状态 |

source_version 唯一约束包含来源身份与正文 hash。旧任务及知识条目保留原 ID 和时间。索引是可重建派生数据，不能成为原文唯一副本。

### 10.3 执行状态

新任务使用 queued、running、waiting_retry、completed、failed、cancelled、needs_attention。具体阶段 retrieving、generating、validating 等放在 stage 字段，不用虚构进度百分比。

~~~mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running
    queued --> cancelled
    running --> completed
    running --> waiting_retry
    waiting_retry --> running
    running --> failed
    running --> cancelled
    running --> needs_attention
    needs_attention --> failed
~~~

completed 的内容可以是资料不足；任务运行失败与“材料不能回答”分开。

领取任务在短 BEGIN IMMEDIATE 事务中完成：选择到期任务、更新 lease_owner、递增 lease_version、写 lease_expires_at 后提交。外部 HTTP 和模型调用一律在事务之外进行。数据库允许多个读事务但只有一个并行写事务，不能用未加事务的“先查后改”领取任务。[S9]

初始 lease 60 秒、心跳 10 秒。心跳与最终提交都校验状态、lease_owner 和 lease_version。旧执行器的晚到结果不能覆盖新状态。

### 10.4 重启与重试

- 已接受的 Capture 原文在响应前提交，重启后仍存在。
- queued 任务恢复后继续排队。
- running 任务若尚未发出外部请求，且预算允许，可以安全恢复。
- 已发出模型请求但没有落盘结果：默认进入 needs_attention，显示“上次调用结果未知，可能已产生用量”，不盲目自动重发。
- HTTP 429 等明确可重试故障遵守 Retry-After、冻结策略和总调用上限。
- 格式修复与网络重试共享总计 2 次生成调用预算，不各自再套一个无限重试器。
- 用户明确重做任务时创建新请求 ID，并记录 retry_of。
- 迁移的旧任务保留“中断后失败、人工决定重跑”的既有语义。

取消先持久化，再尝试 Abort 外部请求。取消和完成竞争由数据库状态决定；取消胜出时晚到结果不得写成功。取消请求不能保证供应商没有计费。

## 11 人工确认与 ThinkFlow 写回

本地保存回答、人工确认入知识库、写回 ThinkFlow 是三个不同状态，界面分别显示。

确认时固定：

- task_id 和 result_revision。
- 完整内容与 content_sha256。
- 目标空间、ThinkFlow 服务身份、用户和笔记本。
- confirmed_at 和写回 intent ID。

默认一份已确认任务版本对应一次写回意图。首次确认后内容锁定；再次编辑形成新修订，不能沿用旧确认去覆盖。

新写回的上游 metadata 增加 personal_agent_writeback_intent_id，以它作为该版本的重复检测标记，同时保留 task_id、result_revision 和目标信息。同一修订重复确认复用同一个 intent；同一任务的新修订确认后生成明确的新文档，不覆盖旧版。

旧适配器只按 personal_agent_task_id 查重，必须同步调整：只有迁移的旧 intent 才按旧 task 标记核对，并映射到相应旧版本；不能把不同修订都套进旧的单 task 查重逻辑。历史文档和旧接口行为保留兼容。

处理方式：

1. 事务性保存 writeback_intent。
2. 单执行器处理该意图，查上游任务标记。
3. 未发现已有记录且首次提交状态明确时创建文档。
4. 回读正文并核对 hash 与内容后才标记成功。
5. 请求响应丢失时进入 reconciliation_required，优先查询上游。
6. 找到唯一匹配文档则恢复成功；多份或内容不符则显式冲突。
7. 查不到且无法排除先前请求仍在执行时，停止盲目再次 POST，交给人工核对。

现有上游没有经过验证的原子唯一键保障。这里提供重复检测与故障核对，不宣称跨系统 exactly-once；SQLite lease 只能阻止旧执行器覆盖本地状态，不能撤回已经发送的上游写入。[R3]

首版 Watch 不负责审阅长报告并确认写回；确认入口保留在 Web，避免小屏误操作。

## 12 安全边界与数据处理

这些约束对应本次把本机应用接到远程设备的实际变化：

- 生产流量使用 HTTPS；不为方便联调全局关闭 ATS 或证书验证。
- 只信任明确配置的反向代理；不因为客户端带 X-Forwarded-* 就绕过来源限制。
- 设备权限只允许 Capture、Ask、自己的授权空间结果读取；无模型设置、导出或任意上游请求权限。
- 模型 URL 由服务器配置，设备输入不能控制请求目的地。
- ThinkFlow 保持回环或明确受限的内部网络服务，其上游内部 key 不当作公网用户认证。
- 原文、模型输出与 Markdown 都是不可信内容。Web 禁用原始 HTML 或做可靠清理，链接限制允许协议；Watch 优先纯文本。
- 服务端模型密钥、Apple 签名材料、ASC 私钥不进入 Git、Watch 二进制、用户导出或日志。
- 记录 request_id、job_id、状态、延迟、错误类别；默认不记录全文 prompt、Authorization 或上游原始错误响应。
- 限制登录、配对、任务创建速率及队列大小，防止暴露的个人 API 被滥用消耗额度。
- 本地或私有存储不代表内容不出机：云模型会收到问题与入选证据；云 embedding 若启用也会收到资料。
- 用户删除空间或任务后，服务端清理对应数据与索引；历史备份和暂离线的 Watch 缓存按明确保留政策处理，不承诺远程瞬时抹除。
- 解除连接提供“保留未上传内容”和单独的“删除本地内容”操作，不把重新登录当成清空数据。

## 13 迁移 备份与恢复

### 13.1 workspace.json 迁移

提供显式命令，不在启动失败时偷偷创建空数据库。

1. 停止旧写入进程。
2. 备份 workspace.json 及 ThinkFlow 原生数据，记录文件 hash。
3. 校验版本、ID 唯一性、引用关系与必要字段。
4. 在新 SQLite 的一个事务中导入任务、结果、人工编辑、conversation、events、knowledge、来源快照和 writebackIntent。
5. 保留原始 ID 与时间，过滤凭据字段。
6. 比较实体数量、关键正文 hash、知识与任务关联。
7. 记录 migration_source_hash，提交后切换读取。
8. 保留原 JSON，不双写，不自动删除。
9. 重跑相同来源迁移不重复导入；来源变化时拒绝无说明覆盖。

旧任务可能只保存带 TF 标记的合并 sourceText 和各来源 hash。迁移先原样保留旧任务材料快照及 metadata；只有能复原独立原文并通过旧 hash 校验时，才建立已验证 source_version。无法验证的来源保留历史展示信息并标记待重新同步，不自动成为新问答的已验证证据。

迁移前的备份只能恢复到迁移前状态。迁移后已有新数据时，回到旧 JSON 会丢失这些新增记录，因此回退必须先导出新数据库并明确处理差异。

### 13.2 备份

- 保存 SQLite 的一致性备份及必要原始文件、ThinkFlow 数据、配置版本。
- SQLite 采用受支持的 backup API，或停写并完成检查后的冷备；不能在 WAL 活跃时只复制一个 .sqlite 文件。
- 密钥独立管理，不混入普通业务导出。
- 初始保留策略为每日备份、保留最近 7 份，可配置。
- 至少做一次在全新临时数据目录中的恢复演练，核对数量、正文 hash 和旧引用。
- JSON 导出继续提供可读业务备份，但明确它是否包含 ThinkFlow 原始文件；不能把缺失原始文件的导出标为完整备份。

## 14 后端部署与日常可用性

### 14.1 原型阶段

Windows 运行后端，使用具有 HTTPS 的入口连接手表。公网入口必须经过本项目设备认证；隧道或反向代理提供访问路径，不自动替代业务权限。

此阶段明确依赖电脑开机、后端进程和网络。电脑睡眠时，Watch 可保存待发送内容、查看缓存，不能实时查询这台电脑上的资料。

### 14.2 日常版本

默认推荐单台常开 Linux 服务器或等价的持久运行环境：

- 一个受进程管理器管理的 Node 服务。
- SQLite 位于持久磁盘。
- 反向代理负责 HTTPS。
- 环境或受限配置文件提供模型密钥。
- 每日备份和基本存活检查。
- 首版不做多副本，不把 SQLite 放到多主机共享网络盘。

ThinkFlow 可以作为同机回环服务运行。现有安装脚本包含 Windows 路径与目录联接，不能直接宣称已支持 Linux。需要补充固定提交的 Linux 安装/启动说明、路径映射与真实读写 smoke test。

为减少部署耦合，核心 Capture、已同步资料检索和回答不依赖 ThinkFlow 此刻在线。若暂不在服务器安装 ThinkFlow，可导入已经同步的快照继续使用；ThinkFlow 写回保留为明确未就绪的集成能力。

建议交付 deploy/README.md、环境变量示例、服务管理配置、反向代理示例、健康检查与备份恢复命令。服务商价格与机器规格由实际用量选择，不在此承诺某个免费平台能永久运行。

健康检查分为无敏感信息的 liveness，以及管理员可见的 readiness；后者检查数据库可写、任务执行器心跳，并分别报告 Capture、Ask 与 ThinkFlow 集成能力。缺少模型配置只让 Ask 未就绪，ThinkFlow 离线只让集成降级，不让原文保存或整个服务不可用。

## 15 没有 Mac 的 Apple 构建与安装

### 15.1 完整路径

Windows/WSL 维护代码 → 推送 GitHub → macOS runner 上 Xcode 构建与签名 → App Store Connect 处理 → 内部 TestFlight → 配对 iPhone 安装管理 → Apple Watch 真机运行。

你不必先买 Mac，但编译 Apple 平台应用仍需要云端或远程 macOS/Xcode。GitHub Actions 是构建环境，不是绕过 Apple 签名和分发规则的工具。[S11]

### 15.2 先做最小可分发工程

首选现代 SwiftUI watch-only 工程，不新建旧式 Watch App 与 WatchKit Extension 的业务双 target。

watch-only 可以不附带实际 iPhone App，但分发工程仍可能包含 Xcode 所需的 iOS wrapper stub。Apple 官方说明这个 stub 用于根 bundle ID 和分发，不会在配对 iPhone 安装一个可执行应用。[S2]

实施要求：

- 明确共享 scheme、目标 product type、bundle ID、最低系统、图标及版本。
- 提交可重复生成的工程配置或已验证的 .xcodeproj。
- XcodeGen 可以使用，但先锁定并验证；不能把“生成器声称支持 watchOS”当作成功分发的证据。
- 不提供未经实际构建验证的通用 YAML 来掩盖 wrapper、embedding 或归档问题。
- 最小 App 先只显示版本、连接/配对状态、一个刷新按钮和真实服务端返回。
- 模拟器构建、签名归档、导出、上传处理、真机安装分别记录结果。

如果 watch-only 工程持续被容器或归档配置阻塞，先定位具体工程问题。只有确有收益时，才选择有实际配对/设置用途的极简 iPhone companion；这也是独立的产品决策，不能暗中扩成完整 iOS 项目。该方案仍要通过相同分发验收。

### 15.3 开发者账号

使用 TestFlight 的正式路径需要 Apple Developer Program。当前官方费用为每年 99 美元或当地币种价格；由用户自己完成身份验证、协议和付款。[S12]

免费 Personal Team 的短期设备调试方案不等于免费 TestFlight；其配置由 Xcode 管理，profile 通常 7 天到期，不作为本项目无 Mac 日常使用的默认交付路径。[S13]

账号尚未就绪时继续开发后端、契约、无签名构建和测试，但报告真机分发未完成。

### 15.4 Windows/WSL 从零生成签名材料

以下是待用户在自己的安全目录执行的 bootstrap 示例，不需要把真实私钥发给聊天或提交仓库。

生成受密码保护的私钥和 CSR：

~~~bash
openssl req -new -newkey rsa:2048 -sha256 \
  -keyout distribution.key.pem \
  -out distribution.csr
~~~

在 Apple Developer 网站创建 Apple Distribution certificate，上传 CSR 并下载证书。然后把下载证书与原私钥组合为 PKCS#12：

~~~bash
openssl x509 -inform DER \
  -in distribution.cer \
  -out distribution.cert.pem

openssl pkcs12 -export \
  -inkey distribution.key.pem \
  -in distribution.cert.pem \
  -out distribution.p12
~~~

命令提示输入原私钥密码和 P12 导出密码。下载的 .cer 不含原私钥，不能在申请后丢弃 distribution.key.pem。导入 CI 前验证证书与私钥匹配。

这是基于标准 CSR 和 PKCS#12 的 Windows/WSL 工程路径；Apple 的 CSR 页面示例使用 Mac Keychain，而不是逐步演示 Windows。具体 P12 导入仍需在所选 macOS runner 验证，导入失败时核对密码、格式和证书链。[S14][S15][S16]

### 15.5 App ID profile 与 App Store Connect

先让 Codex 输出 apple-delivery-manifest，列出实际所有需签名 target、bundle ID、scheme、归档 destination 和 profile 映射，再创建账户资源。

示例根 ID 为 com.weihaozhou.personalresearch，Watch ID 为 com.weihaozhou.personalresearch.watchkitapp。只是命名示例，须根据账号可用性与最终工程确认。

- 为实际 target 注册明确 App ID。
- 为需要签名的 target 创建对应 App Store Connect provisioning profile。
- profile 选择的 distribution certificate 必须与 CI 的 P12 对应。
- 具体 profile 数量由实际工程决定，不先写死“一个”或“三个”。
- App Store Connect 的 watch-only 应用记录仍按 Apple 文档选择 iOS 创建，这不等于必须开发完整 iPhone App。
- TestFlight 路径不走 Ad Hoc 的逐设备 UDID 分发流程。[S17][S18]

### 15.6 区分三种密钥

| 材料 | 作用 |
| --- | --- |
| Apple Distribution P12 及密码 | 给应用签名 |
| mobileprovision | 约束 App ID、证书、权限与分发方式 |
| App Store Connect API P8、Key ID、Issuer ID | 认证上传/API 操作 |
| 后续 APNs P8 | 推送认证；与 ASC key 分开 |
| 模型 API Key | 后端调用模型；绝不能打包到 Watch |

首版使用 App Store Connect team API key。由账户持有人申请 API access，再由具备权限的账户持有人或管理员创建满足上传和测试管理需求的 key，记录 Key ID 与 Issuer ID；Issuer ID 不是 Apple Team ID。若改用 individual API key，应调整对应认证方式，不能直接沿用这套参数。申请不保证立即通过，密钥须妥善保管。P8 不能替代 P12 做代码签名。[S19]

### 15.7 GitHub 配置

非秘密配置包括：

- APPLE_TEAM_ID。
- APP_BUNDLE_ID、WATCH_BUNDLE_ID。
- ASC_APP_ID，注意它是数字应用 ID，不是 bundle ID。
- ASC_KEY_ID、ASC_ISSUER_ID。
- WATCH_SCHEME、ARCHIVE_SCHEME。
- 固定的 Xcode 选择、WATCHOS_DEPLOYMENT_TARGET。
- API_BASE_URL，必须是实际 HTTPS 地址。
- 实际 target 到 profile 名称/UUID 的映射。

Secrets 包括：

- APPLE_DISTRIBUTION_P12_BASE64。
- APPLE_DISTRIBUTION_P12_PASSWORD。
- 各 target 的 APPSTORE_PROFILE_BASE64。
- ASC_API_PRIVATE_KEY_BASE64。

临时 Keychain 密码可在 job 内随机生成。Base64 只是编码，不是安全加密；这些值由用户在 GitHub Secrets 页面录入，不写在工作流或聊天中。

### 15.8 三条 CI

| Workflow | 触发与权限 | 验证内容 |
| --- | --- | --- |
| backend-check.yml | 普通 push / PR，无生产密钥 | Windows 和 Linux 上迁移、接口、队列、检索等测试 |
| watch-check.yml | Apple 相关变更，无签名密钥 | 固定 Xcode、工程检查、模拟器 build、必要逻辑测试 |
| watch-testflight.yml | 首期手动触发，受控发布环境 | 签名、归档、导出、上传、处理状态 |

发布流程必须：

1. 检查配置缺项，只输出变量名称。
2. 记录 Xcode、SDK、部署目标和实际 build number。
3. 创建并解锁临时 Keychain，导入 P12，按 GitHub 官方流程配置签名工具对私钥的非交互访问权限，并安装匹配 profiles。
4. 检查可用 identity、证书有效期和 bundle 映射。
5. 使用交付 scheme 生成 xcarchive。
6. 检查 Watch 嵌入结构、版本和签名配置。
7. 按当前 Xcode 支持的 App Store Connect export 方式导出，不盲抄过时参数。
8. 通过 Apple 支持的上传工具或 API 上传。
9. 单独确认 ASC 处理完成，按应用实际加密能力填写所需声明并处理 Missing Compliance 等阻塞；将构建加入指定内部测试组，确认用户自己的 ASC 测试账户能在 TestFlight 看到该构建。上传、处理完成、测试可安装分别记录。[S22][S23]
10. 无论成败都清理临时私钥和 Keychain。

发布构建使用递增且不重复的 CFBundleVersion；发布任务串行执行。拉取请求检查不接触发布 Secrets，不用不可信 PR 代码执行带密钥的发布流程。

不要为跳过提示而未经核实固定填写 ITSAppUsesNonExemptEncryption=false；按最终应用实际使用的加密能力及 Apple 当时的表单要求作出正确声明。

截至本方案日期，Apple 自 2026-04-28 起要求上传使用 Xcode 26+ 和相应 26 SDK 或更新版本。实施时复核当前要求及 runner 实际安装版本；不要把 macos-latest 当作永久固定环境。[S1][S11][S20]

公开仓库的标准 GitHub-hosted runners 当前免费，私有仓库按额度及计费规则运行；这不代表所有 runner 规格都免费。[S20]

### 15.9 真机安装

用户在配对 iPhone 上安装 TestFlight，接受测试邀请。Watch-only 应用从 TestFlight 应用列表安装；带 iPhone companion 的应用按其详情安装 Watch 部分。每个测试 build 最多可用 90 天，后续需要更新测试 build。[S21]

IPA 可以是分发产物，但“拿到一个 IPA”不等于 Windows 可以把任意包直接拖进 Watch。本方案的完成点是 TestFlight 中可安装且在真机运行，不能停在生成下载链接。

### 15.10 发布前实际需要用户提供的信息

不要求用户把任何秘密值贴给 Codex 或 ChatGPT。只需确认：

- Apple Watch 的具体型号与当前 watchOS。
- 配对 iPhone 的系统与 TestFlight 是否可用。
- 开发者账号与 App Store Connect 权限是否已开通。
- Team ID、确定的 bundle ID 和后端域名等非秘密配置。
- 所需 Secrets 是否已经由用户录入。
- 目标后端与模型账号是否能从实际运行地区访问。

账号、付款和真机操作是外部交付条件。缺失时准确列为待完成事项，同时继续能独立完成的代码和验证。

## 16 实施阶段与验收门槛

不要把整份设计当作“一次性生成整个工程”的指令。每阶段保持可运行、可回退、可审查。

| 阶段 | 交付 | 通过条件 |
| --- | --- | --- |
| M0A 代码基线与契约 | 差异说明、实施计划、API 与数据迁移方案；最小 Watch 工程与无签名 CI | 旧测试保留；最小工程在云端真实 build |
| M0B 真机分发链 | 配置清单、签名流程、最小 App 上传与安装 | 用户真机启动并显示真实服务端响应 |
| M1 可靠 Capture | SQLite、旧 JSON 迁移与核验、认证、配对、outbox、原文保存、Web 可见 | 旧数据完整保留；断网/响应丢失/重启后只有一份原文，不依赖 LLM |
| M2 资料问答 | 空间、来源同步、中文检索、持久 Ask、结构化结果与引用 | 基于真实资料回答，无证据时明确拒答，退出 Watch 后后端继续 |
| M3 审阅与恢复 | 长报告、确认归档、ThinkFlow 核对、备份恢复、旧引用核查、用量 | 写回不伪报成功；恢复演练和预算检查通过 |
| M4 日常部署与验收 | 常开后端、完整测试构建、设备验证记录、使用文档 | 电脑关闭后常开后端可用；目标真机闭环完成 |
| M5 后续增强 | 向量检索、提醒、表盘、短追问等 | 按独立收益评估逐项进入，不阻塞首版 |

M0B 尽早开始，避免最后才发现签名或工程结构不可分发。等待账号期间可并行推进 M1–M3；未通过 M0B，不扩大 Watch 装饰性 UI 和高级功能，也不宣称原生交付完成。

M0B 的真实响应可以来自仅返回版本和随机请求 ID 的无敏感信息诊断接口；完整业务配对放在 M1，避免两个阶段互相阻塞。SQLite 首次接管旧项目写入前必须通过迁移核验；此前用隔离目录开发，不能以空库替换用户数据。

工期取决于账号审批、当前代码差异、后端环境与真机反馈。用验收门槛推进，不向用户承诺未经依据的固定天数。

## 17 测试与可验证质量

### 17.1 自动测试重点

保留现有 30 项行为保障；变更语义时写清原因与新旧兼容，不为让测试通过删除保护性断言。

必须覆盖：

1. 同一请求重复到达只产生一个 Capture / Ask；不同 body 同 key 返回 409。
2. 服务端已写成功但响应丢失，客户端重试能找回原 ID。
3. 模型未配置、断网或额度用尽时，Capture 仍能保存。
4. 任务被接受后 API 连接断开，不影响后端执行。
5. queued 恢复、过期 lease、晚到结果、取消与完成竞争。
6. 生成请求结果未知时不无限自动重试；总调用预算生效。
7. 设备撤销、过期、越权空间、设备 token 调管理员接口均被拒绝。
8. 配对首次响应丢失后，重试得到同一有效会话和可显示短码；过期、猜码限速、未批准权限均正确。
9. ThinkFlow 列表失败不清空旧索引；新旧答案分别引用自己的快照。
10. 中文两字词、中英混合词、引号和 FTS 保留字不会造成错误查询或注入。
11. 引用不存在、未提供或跨空间证据时拒绝结果。
12. 原文和生成内容含脚本/恶意链接时不执行。
13. 写回响应丢失先核对；多份或正文冲突可见；同修订只写一份、新修订可形成新文档、旧任务标记仍能正确核对。
14. 旧数据迁移后 ID、原文、人工编辑、追问与知识关联不变。
15. 备份可恢复，不能只证明导出文件存在。
16. usage 缺失显示 unknown；列表和简报读取不触发模型调用。
17. 旧本机模式仍不接受未经允许的远程 Host/Origin。

### 17.2 真实模型评测

准备一个可复用、可公开的脱敏 fixture 集，包含约 30–40 个问题：

- 原文可直接回答。
- 跨两份资料比较。
- 需要保留适用条件或识别互相矛盾的信息。
- 中文术语、英文缩写、同义表达。
- 没有答案、时间不匹配或资料不足。
- 材料中夹带伪指令。

记录候选 chunk、实际证据、最终回答、引用、模型配置、提示词版本、耗时和 usage。将检索遗漏、生成错误、引用不支持分别归因。

建议首轮目标：可回答问题的 Recall@8 达到约 85% 或更高；关键事实引用支持率约 90% 或更高；无证据问题不编造答案。它们是待测目标，不是已经达成的性能。

固定语料和分块版本，并为每题标注必要证据集合：Recall@8 按前 8 个证据中命中的必要证据数除以该题必要证据总数，再按题平均。需要两份资料而只找到一份应计部分召回，重叠块不能重复计功。引用支持率以关键事实和推论为单位人工判断，未引用的事实也计入分母；无证据问题单独报告正确说明不足和错误作答的数量。

不要用一条“看起来正常”的回答代表 RAG 质量，也不要把另一个 LLM 的评分当作唯一依据。优先人工核对小规模基准；以后再自动化。

### 17.3 真机必测

- 配对成功、撤销后失效、重新连接不丢 outbox。
- 中文系统输入、听写可用性与输入确认。
- 离线保存，退出 App，再打开原文仍在。
- 提交响应丢失后重传，服务端只有一条记录。
- 提交结果未知时不显示可立即取消的“未发送”状态；核对已接收后展示服务器真实状态。
- 保存离线条目后更改默认空间，条目仍归原空间。
- 原空间删除后内容保留并显示待处理。
- 提交 Ask 后立即退出，稍后查看真实完成结果。
- 后端不可达显示待发送，不伪装“正在研究”。
- 缓存结果标记时间；无来源的问题显示资料不足。
- 小屏、较大文字、长标题、VoiceOver 标签和按钮可触达。
- 真机网络路径切换及应用前后台切换。
- TestFlight 升级后本地数据与配对状态迁移正确。
- 切换后端或拥有者后旧缓存不可见，旧 outbox 不自动外发；成功确认的 outbox 可以清理，未确认原文不会被清缓存顺带删除。

模拟器无法替代听写、实际网络、电量及安装体验验收。未测项写在验证记录中，不虚构通过结果。

### 17.4 性能目标

- 已配置且网络正常时，服务端接受 Capture / Ask 的处理时间 P95 目标低于 1 秒，不含外部网络往返。
- 健康后端的真实 Watch 提交反馈目标在数秒内。
- 小规模资料检索目标在 1 秒内；用实际语料测量。
- 模型生成目标为几十秒内可用，失败有清楚原因；不承诺供应商一定满足固定延迟。
- 不在后台持续轮询，不做常驻音频会话；首版不编造具体续航提升数据。

## 18 Codex 应交付的仓库内容

目录是职责建议，可根据现有代码做小幅调整，不能为了匹配目录重写业务。

| 目录或文件 | 内容 |
| --- | --- |
| lib/config.mjs | 模式、模型、权限、预算及路径的统一配置 |
| lib/store/ | SQLite、schema migrations、旧数据迁移 |
| lib/auth/ | 管理会话、设备、配对与权限 |
| lib/routes/ | 本机兼容、管理员与设备路由 |
| lib/jobs/ | 任务领取、lease、恢复、尝试和事件 |
| lib/kb/ | 来源同步、切块、语料版本、中文检索 |
| lib/llm/ | 供应商适配、预算、输出 schema 与引用校验 |
| lib/thinkflow.mjs | 保留并增强的上游适配器 |
| public/ | 原网页及新增空间、设备、任务与证据界面 |
| apple/ | SwiftUI Watch 工程、网络、Keychain、outbox、页面和测试 |
| .github/workflows/ | 后端检查、Watch 检查、TestFlight 发布 |
| scripts/ | 初始化、迁移、备份、恢复和环境检查 |
| deploy/ | 常开后端部署说明与配置示例 |
| test/fixtures/ 与 eval/ | 契约样例、检索及真实模型评测集 |
| docs/API_CONTRACT.md | 已实现接口，不把计划接口写成已实现 |
| docs/APPLE_DELIVERY.md | 从无证书到真机的步骤、目标清单和故障定位 |
| docs/VERIFICATION.md | 自动、真实服务、真机三类验证证据 |
| PROJECT_HANDOFF.md | 当前进度、变更、运行方式、已知问题与下一步 |

不强制新增 React、FastAPI、Redis、LangChain 或大型 Agent 框架。需要新依赖时说明它解决哪个具体问题，固定版本并在 Windows/Linux CI 验证。

## 19 给 Codex 的启动指令

把本文件放入本地仓库 docs/WATCH_PRODUCT_DESIGN.md，再把下面指令交给 Codex：

> 以 docs/WATCH_PRODUCT_DESIGN.md 为目标设计，在当前 personal-research-agent 仓库渐进实现。先读取 AGENTS.md、README、git status、现有代码与测试，比较当前 HEAD 和设计基线，保护未提交工作。
>
> 先完成 M0A：给出实际代码差异、阶段实施计划和第一批可运行改动；同时搭建最小 Watch 工程及不需要 Apple Secrets 的 macOS CI。把 API 与数据迁移契约写清，再进入 M1。优先证明可安装链路和可靠 Capture，不一次性堆满所有功能。
>
> 默认不在 Watch 部署模型，不新增本地生成模型依赖；云端生成、后端持久任务、中文资料检索是主路径。保留现有来源快照、人工确认、写回核对、凭据保护和旧任务恢复行为。
>
> 没有 Apple 账号材料或真机时，完成所有可独立实施的代码、CI、配置模板和明确操作说明，将真正缺失的外部步骤列出。不得伪造上传、真机运行或真实模型评测结果；不要要求我把密码、私钥、API Key 贴到普通聊天。
>
> 每个阶段都运行与本次风险相关的验证，更新 PROJECT_HANDOFF.md 和 docs/VERIFICATION.md，报告改了什么、为什么、测试证据、未完成事项、下一阶段。实现完整设计所需工作，但遇到破坏性数据操作、付费账号操作或对外发布时先给出具体可审查结果，按我的明确授权执行。
>
> 可以连续推进已经授权的可逆实现和验证，不为常规工程选择逐步请求确认；只有真实外部条件或权限边界阻塞时暂停相关步骤，并继续其他独立工作。
>
> 发现设计与平台或现有代码冲突时，指出具体证据并提出最小修正，不暗中更改产品范围，不用 Mock 成功代替真实交付。

## 20 参考来源

平台事实按 2026-10-21 检查；Apple、GitHub 和运行时要求在具体发布前再次复核。

### 仓库基线

- [R1 README](https://github.com/Weihao-Zhou03/personal-research-agent/blob/f871d18c313ee91c09874f3efe13b3c321a8cf84/README.md)
- [R2 模型处理](https://github.com/Weihao-Zhou03/personal-research-agent/blob/f871d18c313ee91c09874f3efe13b3c321a8cf84/lib/processor.mjs)
- [R3 ThinkFlow 适配](https://github.com/Weihao-Zhou03/personal-research-agent/blob/f871d18c313ee91c09874f3efe13b3c321a8cf84/lib/thinkflow.mjs)
- [R4 服务与持久化](https://github.com/Weihao-Zhou03/personal-research-agent/blob/f871d18c313ee91c09874f3efe13b3c321a8cf84/server.mjs)
- [R5 旧任务恢复测试](https://github.com/Weihao-Zhou03/personal-research-agent/blob/f871d18c313ee91c09874f3efe13b3c321a8cf84/test/server.test.mjs)

### 官方技术资料

- [S1 Apple SDK minimum requirements](https://developer.apple.com/news/upcoming-requirements/?id=04282026a)
- [S2 Creating independent watchOS apps](https://developer.apple.com/documentation/watchos-apps/creating-independent-watchos-apps)
- [S3 WKInterfaceTextField](https://developer.apple.com/documentation/watchkit/wkinterfacetextfield)
- [S4 Making default and ephemeral requests](https://developer.apple.com/documentation/watchos-apps/making-default-and-ephemeral-requests)
- [S5 Keeping your watchOS content up to date](https://developer.apple.com/documentation/watchos-apps/keeping-your-watchos-app-s-content-up-to-date)
- [S6 Authenticating users on Apple Watch](https://developer.apple.com/documentation/watchos-apps/authenticating-users-on-apple-watch)
- [S7 SQLite FTS5](https://www.sqlite.org/fts5.html)
- [S8 Node SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html)
- [S9 SQLite Transactions](https://www.sqlite.org/lang_transaction.html)
- [S10 SQLite WAL](https://www.sqlite.org/wal.html)
- [S11 GitHub Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
- [S12 Apple Developer Program](https://developer.apple.com/programs/)
- [S13 Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account)
- [S14 Create a certificate signing request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
- [S15 OpenSSL req](https://docs.openssl.org/3.3/man1/openssl-req/)
- [S16 OpenSSL pkcs12](https://docs.openssl.org/3.3/man1/openssl-pkcs12/)
- [S17 Create an App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile)
- [S18 Add watchOS app information](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-watchos-app-information)
- [S19 App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
- [S20 GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [S21 Testing Apps with TestFlight](https://testflight.apple.com/)
- [S22 Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)
- [S23 Provide export compliance information for beta builds](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds)

