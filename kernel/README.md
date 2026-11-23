# Code2Knowledge Reverse Kernel

共享源码位于本目录；从 MIT Skill 1.0.2 提取，知识产物契约保持 2.0。

仅通过 `@code2knowledge/reverse-kernel` 的公开入口调用模板、规范、解析与校验。
内核不加载用户配置，不执行 Git、模型、通知、向导、授权、审核或任务调度。
`writeMaintenanceTemplates`、`writeBusinessTemplates` 只写调用方明确目录，已有文件不覆盖；调用方负责目录隔离和许可。
`validateContract` 保留旧报告，`inspectContract` 增加稳定分类诊断；通过均不代表业务正确或已审核。

平台运行时以 workspace 依赖使用；独立 Skill 通过 `scripts/sync-skill-kernel.mjs` 生成自包含镜像和哈希清单，禁止手工修改镜像。同步同时维护 Skill 的三份规范及 ontology/rules，避免两套规则漂移。

验证：`pnpm --filter @code2knowledge/reverse-kernel test`。修改后运行根目录 `pnpm verify` 和双入口兼容检查，详见根目录维护说明。当前不执行 npm 发布。

许可：新增及维护代码为MIT；继承的本体、模板等历史部分保留原ISC声明，见THIRD_PARTY_NOTICES.md。
