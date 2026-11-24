# Code2Knowledge Reverse Kernel

本目录是共享逆向内核唯一源码，归属独立Skill仓库。MIT与历史ISC声明随包保留，知识契约保持2.0；代码版本0.1.0独立演进。

只通过 `@code2knowledge/kernel` 公开入口调用模板、规范、解析和校验。内核不加载用户配置，不执行Git、模型、通知、向导、授权或任务调度。写模板保留已有文件；调用方负责目录隔离与许可。校验通过不代表业务正确或已审核。

维护：在本目录 `npm ci`、`npm run build`、`npm run typecheck`、`npm test`。黄金基线与测试资料随源码维护；不得随生成器刷新以掩盖兼容变化。

Skill与平台均通过精确npm依赖消费已发布的 `@code2knowledge/kernel@0.1.0`，不再保存运行代码副本。Skill根scripts/sync-skill-kernel.mjs仅从已安装内核生成宿主阅读用规范、本体和规则。修改本目录源码后需先发布新内核版本，再显式升级消费者依赖与锁文件。

发布：从本目录执行 `npm publish --access public`；prepublishOnly强制构建、类型及测试。发布前还须在Skill根校验生成资料，并执行平台双入口独立打包验收。详见Skill根README；不执行Skill安装钩子，不自动发布Skill。
