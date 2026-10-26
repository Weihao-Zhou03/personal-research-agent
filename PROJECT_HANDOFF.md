# 当前版本交接

更新时间：2026-10-26。设计：`docs/WATCH_PRODUCT_DESIGN.md`；分支：`codex/watch-capture`。当前版本集中一个PR，保留阶段提交，不自动合并。用户改为由Codex主导设计核对、自审、实现与验证，不再等待另一个ChatGPT审查；当前先完成Windows电脑端试用。

- PR：[当前版本 #1](https://github.com/Weihao-Zhou03/personal-research-agent/pull/1)，由Codex继续在同分支自审修复；阶段提交保留，暂不合并。
- M0A：云端真实Watch编译/无签名归档已通过；M0B配置注入、签名/上传人工门禁和安装说明已实现，真实签名及安装未运行。
- M1–M3：Capture/索引、中文冻结资料检索、持久Ask/调用预算/恢复、结构化简报、Web审阅修订、确认归档与上游核对已集成；后端Windows/Linux各135项、Watch30项/工具17项及编译/无签名归档通过，真机未验证。
- M4：Linux单机systemd/Caddy配置、固定ThinkFlow安装、每日7份一致性备份与新目录恢复具备；WSL真实上游与HTTP+云模型完整smoke通过，未部署常开公网主机。
- 评测：公开36题v2真实gpt-6-luna，35完成、1调用超时结果未知未重发；6道无答案题5正常拒答。AI初审仍见q13简报缺条件，人工支持度审查待完成，见eval/README.md。
- 外部阻塞：尚无常开主机/域名，也无本地Mac或付费Apple会员；有Watch与iPhone，但型号/系统及真机操作待确认。免费Personal Team需要Xcode本地安装并定期重签；GitHub云编译已通过，不替代设备安装授权。现用JSON未迁移，秘密只在安全设置录入。
- 证据源码：5e874f40a208ebee6f1fb11400e9950efaeb0828；[后端CI](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39573171787)、[macOS CI](https://github.com/Weihao-Zhou03/personal-research-agent/actions/runs/39573171480)。真实smoke为干净同SHA，1次gpt-6-luna及实际ThinkFlow写回读回；详情`docs/VERIFICATION.md`。
- 运行/部署/安装：`docs/CAPTURE_SETUP.md`、`deploy/README.md`、`docs/APPLE_DELIVERY.md`。下一步先复核q13简报条件遗漏及失败恢复，完成隔离电脑端资料/问答/引用/修订/确认试用；后续再决定常开部署及TestFlight。2026-10-26只核对现状与官方安装要求、更新协作说明，未新增程序或真实服务验证；不将既有结果记作新测试。
