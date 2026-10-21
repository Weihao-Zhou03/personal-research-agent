# Personal Agent · 电脑端科研学习助手

这是一个不依赖树莓派的 Windows 电脑端原型：从 OpenDCAI/ThinkFlow 选取资料，确认目标后后台整理，审阅结果并追问，最后人工确认写回同一 ThinkFlow 笔记本。也支持直接粘贴材料并存入本地知识库。

当前电脑没有麦克风，默认使用**模拟语音输入、字幕和文字录入**来演示交互。它们不会录音，也不代表已经验证真实语音识别或树莓派设备表现。

## 启动和停止

需要 Windows 和 Node.js 22 或更新版本；本项目没有需要安装的 npm 依赖。

双击项目根目录的 `start.cmd`。启动器会复用已经运行的服务，在需要时隐藏启动本项目后端、已安装的本地 Ollama 和 ThinkFlow，并打开浏览器：

<http://127.0.0.1:4317>

本机已安装 ThinkFlow，原生工作台为 <http://127.0.0.1:8437>。8000 端口已有 Docker 服务，因此接入使用独立的 8437 端口。换电脑首次安装时，需 Git、uv、Node.js/npm 和网络，执行 `powershell.exe -NoProfile -File .\scripts\setup-thinkflow.ps1`。脚本固定上游提交和 Python 依赖，安装在 `.runtime/thinkflow`，不会要求你配置 Supabase 登录。

也可以在项目目录打开 PowerShell：

```powershell
powershell.exe -NoProfile -File .\scripts\start.ps1
```

不打开浏览器或不启动可选的代理核心：

```powershell
powershell.exe -NoProfile -File .\scripts\start.ps1 -NoBrowser -SkipProxy
```

临时不启动 ThinkFlow 可追加 `-SkipThinkFlow`；手动粘贴材料的流程仍然可用。

停止本项目登记的后台服务：

```powershell
powershell.exe -NoProfile -File .\scripts\stop.ps1
```

启动器将进程 PID 和创建时间登记在 `.runtime`，停止前还会检查实际进程的可执行文件与命令行，防止 PID 被其他进程复用后误停。已经运行的用户代理或其他已有服务会继续运行；本项目安装脚本启动的 Ollama 会在路径、PID、创建时间和监听端口确认后登记管理。关闭网页不会停止后台任务。

如果 Windows PowerShell 提示脚本被执行策略阻止，启动器不会更改安全策略，也没有使用 `ExecutionPolicy Bypass`。可在项目目录运行 `node server.mjs` 启动网页后端，并使用已有 Ollama/代理，或在界面选择无需模型的规则提取。需要组织管理的电脑应按照现有管理要求处理脚本策略。

## 第一次使用

1. 在工作台使用示例或模拟语音入口，也可以直接输入任务目标，粘贴课堂笔记、论文摘录或讨论记录正文。
2. 点击“选取资料”，从 ThinkFlow 选择笔记本、勾选资料并“读取预览”，检查正文后点击“使用已读取资料”。也可在弹窗里创建笔记本、保存文字资料。手工登记的普通 URL 只保留出处，不会自动抓取网页。
3. 预览任务，检查目标与材料，点击“开始处理”。保留草稿不会执行任务。
4. 在“我的任务”查看状态、结果和来源；可以编辑、追问、朗读，并通过“停止”按钮中止播报。
5. 核对内容后，ThinkFlow 任务点击“确认并写回 ThinkFlow”，普通任务点击“确认存入知识库”。写回会创建 ThinkFlow 原生文档，再读回核对，成功后保留本地确认记录。可用“读取 ThinkFlow 文档”查看当前真实正文。知识库支持搜索、单条 Markdown 下载和本地业务数据 JSON 导出。

完整接口、能力核查与故障恢复见 [ThinkFlow 接入说明](docs/ThinkFlow接入说明.md)。通俗项目手册见 [Personal Agent 项目说明](docs/Personal%20Agent%20项目说明.docx)。

## 选择处理方式

在“设置”中切换后点击“保存设置”，再使用“测试已保存的配置”。这是**手动切换**，没有自动云端兜底；连接测试通过也只说明服务及模型列表可访问，实际生成应通过任务验证。

| 方式 | 服务地址 | 模型 | 能力与限制 |
| --- | --- | --- | --- |
| 本地提取 | 不需要模型服务 | 无 | 完全由程序规则摘录原文、分类疑问与行动候选；追问是关键词检索，**不是 AI 总结或推理**。 |
| Ollama 本机模型 | `http://127.0.0.1:11434` | `qwen2.5:1.5b` | 小模型选择相关原句，程序校验句子编号并保留原文；不自由改写科研结论。复杂解释、推理和综合总结使用云端。 |
| 本机 OpenAI 兼容代理 | `http://127.0.0.1:8317/v1` | `gpt-6-luna` | 请求经过已有代理进入配置的模型服务；这是云端处理，并不因为入口是本机地址而变成本地推理。 |

界面提供本地小模型和本机代理预设，填入预设后仍需保存。检测到指定代理配置时，首次启动会采用该代理的默认设置；此后沿用自己已保存的选择。

本地模型的材料正文最多 5,000 字符，完整请求还受 6,500 字符的上下文限制；超限会报错，不会静默截断。它选择的句子仍可能不相关或遗漏要点，入库前仍需核对。早期自由生成测试曾出现漏掉公式中“平方根”的问题，因此当前本地路径只允许返回原句编号，不能把模型编写的文字写成资料事实。

本地模型安装、续传与生成验证由下面的脚本负责，启动器本身不会自动下载大文件：

```powershell
powershell.exe -NoProfile -File .\scripts\setup-local-model.ps1
```

便携版可执行文件位于 `.runtime/ollama/ollama.exe`，项目模型目录为 `.runtime/models`。启动本项目 Ollama 时，`OLLAMA_HOST` 与 `OLLAMA_MODELS` 仅作用于启动进程及其子进程，不修改用户或系统环境变量。如果复用原有 Ollama，则继续使用该服务本来的模型目录。

当前代理配置入口由 `lib/proxy-config.mjs` 指定，位置为用户目录下的 `Desktop/EasyCLIProxyAPI-v0.3.9-Windows-amd64/EasyCLIProxyAPI-v0.3.9-Windows-amd64/config.toml`。后端只按需读取其中的本地客户端 `api-keys` 到内存，不读取或复制 OAuth 文件。可选代理核心使用其 `cpa-core/cli-proxy-api.exe` 和完整的 `cpa-core/config.yaml`。代理已经运行时会直接复用，停止脚本不会接管或关闭该已有代理。

手动填写的 API Key 仅保存在当前后端进程的内存，不写入项目数据、不回显，也不包含在导出中；重启后需要重新提供。检测到的本机代理凭证会按需重新读取。也可由调用进程提供 `PERSONAL_AGENT_API_KEY`；此时凭证来源由该调用环境管理。

## 数据与当前边界

- 任务、结果、对话、来源登记和人工确认的知识条目保存在 `data/workspace.json`，更新采用临时文件替换。配置中的服务地址、模型名称会保存，密钥不保存。
- ThinkFlow 原生资料和文档实际保存在 `data/thinkflow/outputs`，通过目录联接供原版后端访问。备份时停止服务并复制整个 `data`；页面 JSON 导出不包含 ThinkFlow 原始文件与版本目录。
- 任务按顺序排队。服务运行期间可以关闭页面，稍后再回来查看。电脑睡眠、关机或后端退出后不能继续处理；重启时中断任务会标为失败，需人工重新确认执行。
- 本地目录中的资料正文是普通文件，应按自己的文件备份方式管理。知识库页可导出 JSON 备份；当前没有图形化导入恢复功能。
- 模拟语音是当前无麦克风电脑的默认演示方式，界面不请求麦克风。代码保留了浏览器真实语音识别函数，当前未开放真实收音入口；以后启用时仍需检查浏览器支持、权限与是否调用在线服务。真实收音、识别准确率与说话打断没有在这台电脑上实测。
- 朗读使用浏览器语音合成，可停止播报；可用中文声音取决于浏览器和系统。它不代表树莓派扬声器与实时语音链路已验证。
- 当前已接通 ThinkFlow 笔记本、原始资料读取、模型整理和人工确认后的原生文档回写。任务绑定来源编号、SHA-256、句段范围和读取快照；创建任务时重新读取，发现与预览不一致则要求重选。生成不会自动写回，首次确认后锁定该次内容，失败可核对重试。
- 这次接入没有启用 ThinkFlow 的 embedding 服务或文档 RAG，也没有 BM25 与向量融合重排、Skills 加载器、Plan-and-Execute 或研究关系图。按清单读取所选全文不等于检索增强生成。没有常驻唤醒词、全局热键或硬件设备控制。
- 树莓派部署、低功耗、远场拾音和截图中的“6 类场景验证”尚未完成，本原型不据此宣称已有硬件验证结果。

## 开发结构

```text
server.mjs                 本机 HTTP 服务、任务状态机、串行队列与原子持久化
lib/processor.mjs          规则提取、Ollama 与 OpenAI 兼容接口、任务整理和追问
lib/proxy-config.mjs       指定本机代理位置，按需读取客户端密钥
lib/thinkflow.mjs          ThinkFlow 原生 API 适配、正文快照与可重试回写
public/                   中文网页界面、模拟输入、任务与知识库、浏览器播报
test/                     Node 原生测试，使用临时目录与模拟服务隔离验证
scripts/start.ps1          复用服务或隐藏启动、PID 与进程身份登记
scripts/stop.ps1           校验身份后停止本项目登记的进程
scripts/setup-local-model.ps1  便携 Ollama 与本地模型安装、生成验证
scripts/setup-thinkflow.ps1    固定提交安装原版 ThinkFlow、构建原生 UI
scripts/run-thinkflow.py       本机包装入口，限制 Host/Origin 并挂载原生 UI
scripts/thinkflow-requirements.lock  本次部署使用的精确 Python 依赖版本
data/workspace.json       本地业务数据（运行时生成）
data/thinkflow/outputs/   ThinkFlow 原生资料、文档及其版本（运行时生成）
.runtime/                 本地运行时、模型、日志与进程登记（运行时生成）
```

后端只监听 `127.0.0.1`，默认端口 `4317`；静态文件使用固定白名单，API 拒绝不匹配的 Host 和 Origin。参考材料与来源名称是数据，不是可执行指令；AI 请求将任务要求与不可信资料分开，输出仍需人工审阅。

直接前台运行或执行测试：

```powershell
node server.mjs
npm test
```

`npm test` 不启动真实云端生成，也不依赖树莓派。真实本地模型的生成验证结果由安装脚本另存为 `.runtime/local-model-smoke.json`，该结果只对应当前 Windows 电脑。

自动测试共 30 项，均已通过，包含 ThinkFlow 资料校验、人工确认、并发控制、响应丢失及重启后恢复。真实联调另外验证了 gpt-6-luna 整理与 ThinkFlow 原生文档读写。启动器实际完成了复用服务、新建及停止登记的后端、Ollama 和 ThinkFlow，并保留原有代理，再次启动后数据可读取。进程身份不匹配等保护分支已静态审查，未逐项执行隔离故障测试。

遇到启动问题时，查看 `.runtime/server.stderr.log`、`.runtime/ollama.stderr.log`、`.runtime/thinkflow.stderr.log`、`.runtime/proxy.stderr.log`。端口被未知服务占用时，启动器会保留已有进程；请检查占用情况，不要按端口直接结束其他程序。
