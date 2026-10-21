# 当前版本交接

更新时间：2026-10-21。设计：`docs/WATCH_PRODUCT_DESIGN.md`；分支：`codex/watch-capture`。当前版本集中一个待审查PR，保留阶段提交，不自动合并。

- PR：[当前版本 #1](https://github.com/Weihao-Zhou03/personal-research-agent/pull/1)，实施中，暂不合并；具体修改及评审过程放PR。
- M0A：已核对macOS run39563062510（c8e0e32264b709963bd70f4be50449dc609eee98），15项Swift测试、模拟器编译、无签名归档及8项结构检查通过；后端run39562283359各60项通过。
- M0B：首个未完成阶段；缺Apple账号/签名、真实HTTPS及设备。继续配置和分发预检，不宣称真机交付。
- M1：Capture后端、配对、SQLite迁移与恢复已有实现；已补Watch Retry-After持久冻结及Ask/简报客户端，新版23项Swift测试待云端执行；Watch真机未验证。
- M2：知识快照/中文检索、持久Ask/lease/调用预算、结构化引用校验与模型配置模块已实现；本机42项相关测试通过，36题合成词法Recall@8=1.0（不代表真实模型支持度/拒答），HTTP/Web集成中。
- M3–M4：修订确认写回、日常部署与备份实施中；按设计连续推进必做范围，可选功能不实现。
- 证据：`docs/VERIFICATION.md`；运行：`docs/CAPTURE_SETUP.md`；Apple：`docs/APPLE_DELIVERY.md`。现用JSON未迁移，私有运行数据不入Git。
- 下一步：完成独立模块及集成验证，尽早重跑Apple云构建，集中更新PR与外部操作清单。
