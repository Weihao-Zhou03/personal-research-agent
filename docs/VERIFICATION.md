# 验证记录

2026-10-21；PR [#1](https://github.com/Weihao-Zhou03/personal-research-agent/pull/1)。最终程序源码为 `5e874f40a208ebee6f1fb11400e9950efaeb0828`。后续证据/文档提交不改变程序源码，不把设计目标、Mock、编译或IPA当作真机交付。

## 对照设计的当前状态

| 阶段 | 已实现与已执行 | 未验收部分 |
| --- | --- | --- |
| M0A | 基线差异/API/迁移契约、最小原生Watch、真实macOS云构建和无签名归档 | 已过该阶段代码/构建门槛 |
| M0B | 严格非秘密配置、实际归档核对、受保护main手动签名/导出/上传脚本、ASC状态及独立安装记录 | Apple账户/真实Team与bundle/profile/cert、签名、上传、TestFlight、Watch启动真实HTTPS响应均未运行 |
| M1 | SQLite/显式旧JSON迁移核验、owner认证/配对、固定身份与空间outbox、未知提交/重启/429、原文保存与独立索引、Web可见 | 后端/Swift替身测试不代替原生断网、听写、Keychain、磁盘错误或真机验收 |
| M2 | 不可变来源/语料、中文预分词FTS5/BM25与短词补召回、持久Ask/lease/预算/恢复、结构化简报/引用、只读Feed | 真实模型36题有1次结果未知；私人资料泛化及人工支持度仍待核对；Watch真实请求未运行 |
| M3 | 长报告/编辑修订、人工本地归档、独立写回意图/真实正文核对、账目保留、活跃WAL备份/新目录恢复 | 语义支持仍需人工；生产数据没有迁移；未做生产灾备切换 |
| M4 | Linux单机systemd/Caddy/私有env/每日7份备份、固定ThinkFlow Linux安装与真实隔离smoke、运行安装说明 | 没有常开主机/公网域名TLS/生产systemd/异机备份/目标Watch设备矩阵；电脑关闭后服务可用未验证 |

可选的embedding/向量融合、APNs、SmartStack、通用解析/OCR、联网搜索、本地生成模型及额外产品平台不在本轮实现范围。未通过M0B，不宣称原生交付完成。

## 自动验证与提交对应

| 检查 | 结果 | 对应源码/边界 |
| --- | --- | --- |
| Windows `npm test` | 135通过、0失败、0跳过 | `eb0ac87a76b88c8186fc9c978863f8e7d79308c4`之前同工作区完整执行；最后仅增加store:false，7项LLM测试另通过；最终完整跨平台CI见下方 |
| 后端Windows/Linux CI | 两个系统各135通过、0失败/跳过；公开词法Recall@8均1.0 | [run39573171787](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39573171787)，head为5e874f4 |
| Python `scripts/apple-tools-test.py` | 17通过 | 合成配置/profile/归档、stderr工具帮助、内部测试组/上传未知journal、清理边界；不访问真实Apple账户 |
| macOS Swift + Watch SDK | 30项Swift/17项Python通过；BUILD SUCCEEDED、ARCHIVE SUCCEEDED；13项实际结构/配置检查全true | [run39573171480](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39573171480)，head5e874f4，实际checkout同7c4f441 |
| 公开词法基准 | 36题中30有答案题Recall@8=1.0，必要事实全部召回；6无答案题也有相关候选 | 实际SQLite/FTS5；本机P95约2.3ms，仅12份小型合成资料；不证明模型拒答、引用支持或私人语料性能 |
| WSL日备+KB | 20通过 | 当时日备6+KB14；活跃WAL、新目录、历史引文/FTS、7份保留、失败不清旧、越界拒绝、锁；后续新增测试由最终CI覆盖 |
| 语法/内容保护 | JS语法、Python工具、bash -n、diff检查、附件hash通过 | 设计文件SHA256仍为0849edaf6df25707e1487198a269fd4dd909bc307c6e03ae49e8f3b613a85bba，与原附件相同 |

后端CI实际checkout为PR合并测试提交 `7c4f4410e0c9705425857a4c7ca8add1f8e87545`，其父为main基线f871d18与分支5e874f4；已通过GitHub API核对两者tree同为 `ea4950a2b4a517a89a072ae0d3944ece3c053f68`。记录这个合并测试提交不代表PR已合并。CI日志实际Node24.19.0、SQLite3.53.3；词法P95 Windows约3.78ms、Linux约3.28ms，仅本次小型合成基准。

测试使用真实SQLite/HTTP，模型与ThinkFlow故障注入通常为受控HTTP替身；它们不等于真实服务或设备测试。

自动覆盖的主要行为：原30项兼容保护；同步事务回滚；正文/时间精确保留；owner+operation幂等与删除tombstone；撤销/到期/范围/Origin/CSRF；响应头后断开及进程重启；独立Capture索引和坏模型配置隔离；中文恶意FTS输入与授权范围先过滤；来源失败不清旧/不可变历史证据；lease竞争/过期fencing/取消胜出；2次共享调用预算/429/未知usage；改修订hash冲突；写回失响应重启核对、重复/错hash冲突和不重复POST；删除不重置额度；恢复旧引用；迟到文件/401/旧刷新不能回灌私有Web正文。UI七项为实际脚本+合成DOM/网络边界，不是浏览器视觉验收。

复现：

```sh
node --version
npm test
python scripts/apple-tools-test.py
node eval/run-lexical.mjs --output lexical-eval.json
# 仅macOS/Xcode 26.6
bash scripts/apple-check.sh
```

## 真实服务闭环

已在干净源码 `5e874f40a208ebee6f1fb11400e9950efaeb0828` 执行：

```sh
node scripts/smoke-research.mjs --allow-generation --allow-write --local-proxy --output .runtime/research-smoke-5e874f4.json
```

报告原样保存到 `docs/ci/research-smoke-5e874f4.json`；SHA256 `e23cf946c847ef06b590961b56a6a98a84ae701f0dbbf87b2ef9666ba4f0d058`；working_tree_dirty=false。实际应用HTTP、SQLite、8317本机代理/gpt-6-luna、WSL18437真实ThinkFlow，原文全部公开合成。08:57:19.526Z至08:57:31.487Z约11.96秒；1次真实生成，usage840输入+343输出=1183 token，接受store:false。密钥只在请求内存，报告逐项排除凭据。

通过：直接导入保留空白；ThinkFlow实际资料读取与原子同步；HTTP模拟Watch配对；Capture201/重放200同ID及零模型索引；Ask202/重放200同ID、后台完成；冻结引文码点/正文hash核对；重复读Feed/状态/简报零新增模型；编辑修订2；显式程序确认/同意图重确认；真实原生文档创建和正文/metadata读回verified；人工GET reconcile不新增写入。保留合成笔记本 `local_1792573039523_b4d4a27c`、文档 `doc_50d0d488ed30`，临时应用和SQLite已清理。

该脚本明确使用程序模拟设备和人工确认动作，不是Watch真机或用户亲自审阅。未验证公网TLS、Keychain、原生outbox、常开主机或TestFlight。此前eb0ac87的干净SHA同链路也通过（1333 token），增加store:false后只重跑这一次完整smoke，没有为请求参数重复36题。

## 真实模型评测与遗留质量问题

`eval/lexical-cases.json`为12份公开合成教学资料、36题及必要证据；数字属于虚构材料。实际使用gpt-6-luna，没有将模型替身记作真实生成。四份原始报告与逐单元初审在 `eval/results/`、`eval/review-model-2026-10-21.json`，保留失败，不选择性删除案例。

- v1的30道有答案题完成；无答案题出现正确说明缺口却被应用额外的fact类型限制拒收。该限制超出设计§8.3，已最小修正；任何状态的fact/inference仍必须引用有效证据。提示词v2同时强调简报的条件、时间与合成属性。
- v2主32题+后续4题覆盖36：35 completed，q32一次调用90秒后needs_attention；已发结果未知、usage未知，未重发。6道无答案题5道正常说明不足，1道未知，不能记成6/6正确拒答。
- 30道有答案题预算截断前后必要证据Recall均1.0。实现团队内独立AI初审201个Watch/headline/fact/inference单元：199支持、2缺条件、0判为无支持；**这不是人工支持率，人工审查待完成**。q13简报标题和首条结论遗漏单用户串行条件，完整报告有条件，已明确留给集中审查。
- 已知完成任务耗时P50约8.08s/P95约16.82s；供应商已知响应attempt约8.06s/16.79s，不含Watch网络，不是纯推理或真机端到端测量。q32未知不塞入成功响应百分位。
- v2实际36已发调用，35次已知usage共82532 token，另1次未知不估0。留存v1/v2诊断与评测共80次已发调用、79次已知181716 token、1次未知；额外真实smoke和浏览器调用另计，没有假定货币价格。
- 首次代理尚未监听时还有36个连接尝试未收到响应，未记为成功模型评测；脚本随后增加只读连接预检和首个未知停止。评测不是生产每日额度账本，所有数据与owner都在隔离临时库。

评测保留执行时base SHA与working_tree_dirty=true，不能将工作区v2运行冒称为该base提交独立通过。最终代码CI和上述干净提交的真实smoke分别绑定明确SHA；不为抹掉dirty标记再消耗整轮模型额度。增加store:false后另做36题纯本地请求重建，实际证据ID全部不变、输入上界全部≤8000（0模型调用，`docs/ci/evaluation-transport-check.json`），只核对传输参数对上下文选择的影响，没有重测答案。真实私人语料、人工支持度和设备质量尚未验证。

## Linux、备份与常开边界

Ubuntu WSL2 x86_64独立私有目录完成固定ThinkFlow提交 `1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3` 克隆、184项锁定Python依赖、npm ci/Vite build及重复安装；Node24.19.0、uv0.12.15官方下载包核验，Python3.11.16。端口18437与独立outputs，未使用用户8437/生产资料。`scripts/smoke-thinkflow.mjs`实际验证旧写回和新M3两修订写回/读回，生成替身1次、真实生成0；与上述全真实模型smoke分开记录。

实际发现固定上游source_manager.py:103在导入时.strip()，同步精确保留的是上游已存正文，无法恢复上游已删边界空白。没有改固定上游；Capture/本应用直接导入仍完整保留原文。

Caddy2.11.7官方包SHA-512核验、caddy validate=Valid configuration，未启动Caddy或申请证书。systemd255对私有unit副本语法校验exit0，仅把示例Node路径替换为本次便携路径；没有安装/启动生产unit。每日备份脚本通过Windows/WSL测试，实际生产timer/主机重启/异机备份未执行。部署步骤见 `deploy/README.md`；WSL随Windows关机而停，不是常开交付。

## 浏览器与Apple验证边界

浏览器实际操作已验证隔离4319管理页登录、TXT原文导入、HTML按文字显示、真实模型结果及引用显示、编辑保存新修订。归档确认之后浏览器自动化被原生confirm/CDP阻塞，未声称该浏览器点击完成归档；确认/写回由真实HTTPsmoke独立通过。最终隐私竞态用七项脚本VM交互验证，未重跑最终浏览器视觉、手机尺寸或真机界面。此前M1浏览器配对/撤销/重载会话也实际执行过，属于合成设备验证。

Apple最终CI实际Xcode26.6/build17F113、Swift6.3.3、watchOS SDK26.5；最低部署版本仍watchOS10。实际归档报告 `docs/ci/watch-archive-39573171480.json` SHA256为4de7719f5afe9ee99451c9b99a7030d67b5ac7bc0c76383738e2ed3c0d0d446e；13项检查含真正注入的合成API/bundle/version/build。工具帮助真实stdout=0、stderr=24217字节，两个支持检查true，报告 `docs/ci/xcode-tool-support-39573171480.json`。artifact ID12332993035，ZIP digest sha256:74df2fe9b73cf70e8ba1ffe26f33c343fa09c29e076e5139d0598a76db7f980f，计划2026-11-04到期；只含日志/JSON，未上传archive/IPA。仓库永久保留上述JSON。

Apple历史证据：首轮run39562283553失败于Swift泛型函数内嵌类型，修复后run39563062510在c8e0e32264b709963bd70f4be50449dc609eee98通过15项、build/archive及8项结构。run39567460679在196e2c4通过23项；run39571296244在f852510通过配置注入后的23项及17项工具测试。历史原始归档报告仍保留 `docs/ci/watch-archive-39563062510.json`。

未运行：实际Apple签名/导出/上传、ASC处理/测试组权限、Missing Compliance操作、TestFlight安装、目标Watch听写/Keychain/断网/切后台/电量/卸载重装/真实HTTPS请求。发布workflow只允许用户审查合并后，对受信main SHA另行明确授权并通过环境review gate执行；本轮没有启用授权变量或读取Apple Secrets。

## 外部操作与集中审查

1. 集中审查PR及公开评测，特别是q13条件遗漏与q32未知调用；决定是否接受首版质量并在后续审查意见中指定调整。不要把AI初审替代人工验收。
2. 选定常开Linux主机及真实域名/DNS/TLS，按部署说明安装服务/私有备份；在目标主机配置可达模型服务。云主机的127.0.0.1不能访问Windows代理。
3. 在Apple/GitHub安全界面准备Team/bundle/ASC App、P12/profiles/ASC team key及受保护环境，秘密不贴聊天；确认目标Watch+iPhone型号和系统。按 `docs/APPLE_DELIVERY.md` 操作。
4. 用户决定合并后再授权指定main SHA签名上传，确认ASC处理/合规/TestFlight可见性，实际安装并按设计§17.3真机场景逐项填写结果。
5. 若切换现用数据，另行审查私有路径、停旧写入者、备份并显式迁移；本轮没有迁移或清除用户现有data，不自动合并PR。
