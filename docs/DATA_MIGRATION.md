# SQLite 迁移契约

M1 在隔离目录开发。已有 JSON 默认仍走旧存储；SQLite 由显式配置选择，不双写。切换旧数据前需要停止旧写入、备份 JSON 与 ThinkFlow 原生目录，执行迁移核验，再启动 SQLite 模式。任何失败不得把空数据库当成成功迁移。

## 旧数据保留

- 先验证 version=1、任务和知识 ID 唯一、知识与任务双向关联、正文和时间字段基本结构。
- 保留原 ID、时间、sourceText、result 的人工编辑、conversation、events、sources、ThinkFlow 元数据和 writebackIntent；未知非秘密业务字段保留。
- 旧 settings 仅接受 provider/baseUrl/model，apiKey 和其他凭据不迁移。
- 一个短事务导入。记录源文件原始字节 SHA-256 和导入后实体/内容核验清单；核验失败回滚。源文件原样保留。
- 相同来源重跑只核验，不重复导入；来源 hash 不同或已有业务数据时拒绝无说明覆盖。
- 旧合并材料和来源 hash 不自动升级为已验证新 source_version。旧引用可历史展示，新检索等待可核验同步。

## 存储与恢复语义

旧工作台的状态读写可通过 SQLite 适配器保存，但继续使用旧队列与旧恢复规则。迁移本身不改变 queued/running；使用旧服务打开后仍转 failed，等待人工重跑。新 Capture 是原始笔记，不触发旧任务、模型生成或正式知识归档。

Capture、owner 级幂等记录和待索引意图在同一个 SQLite `BEGIN IMMEDIATE` 事务提交，提交后才向设备确认。永久 device_secret 只存 hash；管理员 scrypt 校验值、会话、CSRF、配对短码不进入普通业务导出。

Capture索引意图持久化为queued，后台独立索引成功后为indexed；失败仍保留原文并允许显式重新排队。新Ask的lease与预算不会改变迁移旧任务的保守恢复。

## 当前版本的增量表

在显式SQLite模式中新增sources/source_versions/chunks/FTS、corpus_revisions/members、workspace_kb/bindings、research_jobs及attempt/event/evidence/results、research_archives/writeback_intents和非秘密模型配置。旧legacy_tasks/knowledge与原jobs索引意图继续原语义，不整表重写。Capture、Ask、KB、Archive各自检查schema版本；遇未知版本拒绝启动，不能降级覆盖。现有初始KB表可补版本标记；来源正文、版本位置、hash保持不可变。

分词/ICU版本变化可在短事务内重建派生token/FTS，并为当前语料发布相应索引版本；不修改原文、chunk身份/位置或旧答案冻结证据。Node固定24.19.0减少运行时差异，升级仍要先在备份副本演练。

新增research_daily_ledger、research_acceptance_ledger和research_usage_ledger只留owner/day、必要去重ID、调用状态与用量，不含问题/正文/证据或凭据。首次使用从仍存在的已接收任务/已发attempt原子回填，重复启动不重复累计；升级前已删除的历史账目无法补造。删除任务/空间擦除业务内容但不重置额度/已知或未知用量，也保留必要幂等tombstone；普通导出不含认证表。

## 备份与回退

活跃 SQLite 使用 Node `node:sqlite` 的一致性 `backup()` API，不直接复制 WAL 活跃时的主文件。备份包含管理员/设备认证校验值，应当与公开业务导出区别管理，放在私有存储。ThinkFlow 文件和服务端密钥另行备份。

恢复到新的、尚不存在的数据库路径并核对 integrity_check、外键、实体数量、关键 hash 与知识关联。迁移后的新增 Capture 不存在于旧 JSON；回退前先保留新库及新增记录，不能直接用旧 JSON 覆盖新库。

具体命令、已完成的演练和限制见阶段交接记录。当前现用数据尚未切换。
