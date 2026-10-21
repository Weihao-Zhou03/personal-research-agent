# 当前版本交接

更新时间：2026-10-21。设计：`docs/WATCH_PRODUCT_DESIGN.md`；分支：`codex/watch-capture`。当前版本集中一个待审查PR，保留阶段提交，不自动合并。

- PR：[当前版本 #1](https://github.com/Weihao-Zhou03/personal-research-agent/pull/1)，集中审查前收尾；阶段提交保留，暂不合并。
- M0A：云端真实Watch编译/无签名归档已通过；M0B配置注入、签名/上传人工门禁和安装说明已实现，真实签名及安装未运行。
- M1–M3：Capture/索引、中文冻结资料检索、持久Ask/调用预算/恢复、结构化简报、Web审阅修订、确认归档与上游核对已集成；Watch只读刷新/删除fencing新30项Swift测试待最新CI，真机未验证。
- M4：Linux单机systemd/Caddy配置、固定ThinkFlow安装、每日7份一致性备份与新目录恢复具备；WSL真实上游与HTTP+云模型完整smoke通过，未部署常开公网主机。
- 评测：公开36题v2真实gpt-6-luna，35完成、1调用超时结果未知未重发；6道无答案题5正常拒答。AI初审仍见q13简报缺条件，人工支持度审查待完成，见eval/README.md。
- 外部阻塞：常开主机/域名TLS、Apple账号/Team与签名材料、ASC/TestFlight、目标Watch+iPhone及真人设备操作；现用JSON未迁移。秘密只在安全设置录入。
- 证据：`docs/VERIFICATION.md`；运行：`docs/CAPTURE_SETUP.md`；Apple：`docs/APPLE_DELIVERY.md`。现用JSON未迁移，私有运行数据不入Git。
- 下一步：固定最终源码运行跨平台/最新macOS CI和真实smoke；更新验证记录与PR，随后集中审查。账号/真机到位后执行尚未完成的验收。
