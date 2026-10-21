# 验证记录

日期：2026-10-21。设计目标不等于验证结果。本文件分别记录自动检查、真实服务、Apple构建与真机，不能用后一类的 Mock 替代。

## M0A 基线

- 起点与设计基线：f871d18c313ee91c09874f3efe13b3c321a8cf84。初始工作树干净，没有适用 AGENTS.md。
- Windows Node24.19.0 执行 `node --test test/*.test.mjs`：原30项通过。
- 运行时探测：SQLite3.53.3、ENABLE_FTS5=1，DatabaseSync timeout与模块级backup API可用。
- 尚未运行 macOS Watch build；尚未签名、导出、上传 App Store Connect 或安装真机。

## M1 自动测试：Windows / 真实 SQLite / 隔离 HTTP

`npm test` 当前60项：原30项保留，新增11项store、16项Capture/认证/版本保护、2项初始化CLI、1项SQLite ThinkFlow恢复。全部通过，零跳过；不请求真实云端生成。`node:sqlite` 运行时SQLite3.53.3，WAL、同步事务及FTS5探测通过，FTS5可创建不表示中文检索已实现。

| 范围 | 已验证 | 证据边界 |
| --- | --- | --- |
| Capture | 原文/时间精确保留；4000 code point；32KiB；同键同结果/异内容409；并发唯一；异常事务全回滚 | 临时真实SQLite和HTTP；不是Watch网络 |
| 响应丢失/重启 | 客户端在响应头到达后断开，不消费receipt正文；重启服务并换设备凭据重放仍同一ID、一条原文、一项索引意图 | 后端故障注入；没有真机断网 |
| 认证 | pending不能访问业务；批准范围冻结；撤销/90天到期拒绝；配对重放不返回失效授权；撤销pending后不能批准 | 时钟可控测试，不等90天 |
| 管理端 | cookie与Bearer分离、Origin/CSRF、限流、密码轮换和上传期间logout竞态拒绝、导出不含认证表 | HTTP及SQLite；真实TLS证书未部署 |
| 隔离模式 | server缺项拒绝启动；显式可信loopback TLS代理头；旧状态/设置/ThinkFlow接口404 | 模拟代理连接/headers，非实际公网TLS |
| JSON迁移 | 原字节备份、原ID/正文/编辑/追问/事件/来源/确认/知识关联核验，同源幂等，冲突拒覆盖，失败回滚 | 测试夹具；现用data未迁移 |
| 备份恢复 | 模块级backup对活跃WAL快照，新目录恢复，表数量/hash/schema/外键/integrity及旧关联核对；CLI实际执行 | 临时目录；未配置定时备份/保留策略 |
| 旧行为 | 迁移旧中断任务仍人工重跑；SQLite下ThinkFlow来源快照、人工确认锁与丢响应恢复 | ThinkFlow替身HTTP，不是本轮真实上游联调 |
| 初始化 | 没有迁移证据的旧JSON不被空库接管；密码不输出；重复初始化拒绝；空间失败不留下已设置密码的半成品 | 子进程CLI/临时目录，未设置用户实际密码 |

复现：

```text
node --version
npm test
node --test test/store.test.mjs
node --test test/capture.test.mjs test/init-owner.test.mjs
```

## 独立进程与浏览器联调

本轮在Windows的4319端口启动独立真实服务，使用 `.runtime/watch-ui-smoke/data` 隔离SQLite、公开测试密码与合成设备身份。浏览器实际操作通过：登录、建空间、8位码核对批准、刷新取回原文、重新加载恢复会话、撤销设备与退出。CLI以相同Idempotency-Key提交两次，实际201/200且同一capture_id；撤销后设备HTTP401。原文中的 `<b>...</b>` 按文字显示，DOM中没有对应b标签。1039px当前视口未横向溢出；未执行手机尺寸或真实iPhone浏览器测试。

截图为合成输入，保存在本机 `.runtime/watch-ui-smoke/owner.png`，不作为Watch证据；临时服务验证后停止。现用 `data/workspace.json` 验证前后SHA-256相同，未切换生产数据。复现可按 `docs/CAPTURE_SETUP.md` 新建自己的隔离目录；私有运行夹具和日志不提交仓库。

本轮真实模型调用：0。真实ThinkFlow新写回：0。历史接入证据仍属旧项目，不能转记为本轮Watch链路已通过。

## Apple 静态检查与尚未执行项

- `python scripts/apple-tools-test.py`：5项通过，包括配置拒绝placeholder、HTTPS语法及合成archive检查器的拒绝分支。合成目录不是实际archive。
- Apple YAML/JSON解析、Python编译、`bash -n scripts/apple-check.sh`（WSL）、图标尺寸/透明度检查、`node --check public/owner.js`、PowerShell启动器语法通过。`git diff --cached --check -- . ':(exclude)docs/WATCH_PRODUCT_DESIGN.md'`通过；原样设计附件自带Markdown双空格换行与末尾空行，保留以维持来源内容，不算工程格式错误。
- WatchCore有15项Swift测试，覆盖outbox写盘、未知提交、身份/空间冻结、缓存容量、共享fixture、精确配对URL和失效配对解码；**全部待执行，不计入通过数量**。
- `.github/workflows/backend-check.yml`：Windows/Linux；`.github/workflows/watch-check.yml`：macOS核心测试、模拟器build和无签名wrapper archive。已获授权推送并执行，实际记录见下节。
- `watch-testflight.yml`只有readiness说明，未读取Apple Secrets，也没有实际签名、导出、上传或安装能力。

## 阶段结论与外部阻塞

M0A文档与工程已准备，但“云端真实build”门槛未过。M1后端本地闭环通过，Watch编译/真机矩阵未过，整体不标记验收完成。M0B没有实际分发结果。

本机是Windows，没有Swift/Xcode；已通过授权的GitHub macOS runner执行真实编译检查。Apple Developer/ASC权限、真实Team/bundle IDs、证书/profiles/ASC材料、Watch可达HTTPS后端、手表/iPhone型号系统和TestFlight测试人员均未确认。秘密仅在安全配置界面填写。

剩余工作：真实云编译→真实HTTPS诊断→审查签名方案并按授权分发→真机M1故障矩阵。中文检索、Ask、结构化brief、worker lease、日常部署心跳、自动备份及M3新修订归档尚未实现，不能用queued索引、Mock回答或IPA代替。

## 授权后云端 CI 记录

2026-10-21，公开分支 `codex/watch-capture` 已推送，首轮检查提交 `6d43b1105144085cf3d983052ded6265a2ad9124`。

- [Backend checks / 39562283359](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39562283359)：Windows2025与Ubuntu24.04均成功，各60测试通过、0失败；实际Node24.19.0、SQLite3.53.3与FTS5创建通过。
- [Watch unsigned checks / 39562283553](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39562283553)：真实macOS runner可用，Xcode26.6、XcodeGen2.46.0与工程生成通过；Swift核心编译失败，`Envelope`不能嵌套在泛型`request`函数内。已将其提升为APIClient私有类型，错误契约不变，准备重跑。此次未开始Watch模拟器build或archive，不能填M0A通过。

没有使用Apple Secrets、执行签名、TestFlight上传或生产数据迁移。
