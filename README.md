# Code2Knowledge Skill

[官方源码](https://github.com/Muke-Coding/code2knowledge-skill) · [npm 包](https://www.npmjs.com/package/@code2knowledge/skill) · [问题反馈](https://github.com/Muke-Coding/code2knowledge-skill/issues)

**本仓库是 Code2Knowledge 唯一持续维护的版本。旧 [Web 仓库](https://github.com/Muke-Coding/code2knowledge) 停止维护，仅保留历史记录。**

**企业知识链路中的知识生产层：把授权源码与业务资料整理成可追溯、可审核、可版本管理的 Markdown/YAML 资产。**

Code2Knowledge 是一个面向多仓库、多业务域的 Agent Skill。它从源码和补充资料中整理业务概念、能力、规则、流程与风险，生成代码图谱和业务到代码的映射，供产品、开发、测试共同使用。

```text
源码与业务资料 → Code2Knowledge → Git 知识资产 → 文档站 / RAG → MCP → 员工 Agent
```

本项目负责知识提取、代码证据核验、结构化映射、校验和本地导出。Git 提交、业务审核、文档站部署、RAG/Embedding、MCP Server 和员工权限由用户或下游负责；导出不等于审核通过或已发布。不绑定 Onyx、knowledge-rag-plus 等专有格式。

无需启动 Web 服务，无需配置独立模型密钥。安装后，在你常用的 Agent 中输入快捷命令即可开始。

## 功能

- **轻量选择向导**：发现已有任务和原料，选择继续、复用或新建，只补问缺失信息。
- **共享原料**：一个业务中心关联多个仓库，同一份原料可用于多个业务域。
- **证据追溯**：保留仓库 commit、源码路径、行号和 `VERIFIED / UNVERIFIED` 状态。
- **断点续跑**：保存问答选择、分析计划和服务证据，中断后继续。
- **知识契约 2.0**：Markdown frontmatter、业务 YAML meta，保留稳定知识 ID、多仓库完整 commit、来源状态和资料指纹。
- **逐条核验与审核**：区分代码事实、业务规则和推断，代码核验与业务审核分别记录，默认 `pending`。
- **校验与导出**：检查元数据、引用、证据定位与来源版本，交付五个目录；整理后的证据随资产交付。

## 快速开始

### 1. 准备环境

| 环境 | 要求 |
| --- | --- |
| Node.js | 20 或更高版本，包含 npm |
| Git | 可在终端执行 |
| Agent | 已安装并可正常使用，具有文件读取、编辑和命令执行能力 |

支持注册到 Claude Code、Codex、Cursor、Gemini CLI 和 GitHub Copilot（VS Code）。下面以 **Claude Code** 为例。

### npm 安装（推荐）

```bash
npm install -g @code2knowledge/skill
code2knowledge --agent codex --scope user
code2knowledge --agent claude --scope user
```

两边通过链接引用安装目录，后续 `npm update -g @code2knowledge/skill` 可更新。卸载 npm 包会使入口失效。不要用临时解包目录或可能被清理的 npx 缓存作为长期注册位置。仅安装 npm 包不会自动完成 Agent 注册，也不会自动安装所有外部工具。

### 2. 安装本地项目依赖

也可从官方仓库安装源码；将项目保存在固定目录：

```bash
git clone https://github.com/Muke-Coding/code2knowledge-skill.git
cd code2knowledge-skill
npm ci --ignore-scripts
```

将 `/path/to/code2knowledge` 替换为项目实际路径。`npm ci` 只安装 package.json 中的依赖（目前为 yaml），不会自动安装下面的外部工具；npm 安装 Skill 包时同样不会自动安装 Python 工具。

### 3. 准备代码打包与文档转换工具

完整使用流程会按需配套安装工具，并在安装前告知用途与安装方式：

| 工具 | 何时需要 | 安装方式 |
| --- | --- | --- |
| Repomix | 默认启用的代码上下文打包 | 首次执行 `npx -y repomix` 时由 npm 下载到缓存，无需全局安装 |
| MarkItDown | 添加 Word、PDF、Excel、PPT、HTML 等需转换的资料时 | Python/pip 单独安装；仅文本资料不需要 |

提前准备并验证 Repomix（首次可能联网下载）：

```bash
npx -y repomix --version
```

需要文档转换时，推荐使用独立虚拟环境安装，避免修改系统 Python：

```bash
python3 -m venv ~/.local/share/code2knowledge-tools
~/.local/share/code2knowledge-tools/bin/python -m pip install 'markitdown[all]'
export PATH="$HOME/.local/share/code2knowledge-tools/bin:$PATH"
markitdown --version
```

将上述 PATH 设置加入 shell 配置，并确保启动 Agent 的环境也包含此路径。Python 需满足所安装 MarkItDown 版本要求。转换器及特定格式仍可能需要额外系统依赖；安装失败时应报告实际原因，不能声称已就绪。

若未提前准备，Agent 会在实际使用前检查并说明“将配套安装所需工具，Repomix 使用 npm/npx，MarkItDown 使用 Python 虚拟环境”，再按宿主权限完成缺失依赖安装及验证；无需每次重复安装。离线或权限受限时说明阻塞，不静默跳过代码打包或文档转换。

### 4. 注册到 Agent

仍在 Skill 项目目录执行：

```bash
npm run register
```

按提示选择 Agent（例如 Claude Code）和注册范围。个人使用一般选择“当前用户”。也可以直接注册：

```bash
npm run register -- --agent claude
```

看到 `invocation: /code2knowledge` 即表示入口已写入。安装与注册只需一次，请保留项目目录及依赖。

### 5. 在目标项目中启动

关闭并重新打开 Agent 会话。进入**要分析的代码仓库或统一管理知识库的工作目录**，再启动 Claude Code。例如：

```bash
cd /path/to/your-project
claude
```

在 **Claude Code 对话中**输入：

```text
/code2knowledge
```

`/path/to/your-project` 替换为实际目录。快捷命令输入在 Agent 对话中，安装和注册命令执行在系统终端中。

多仓库场景建议固定使用一个工作目录启动 Agent，再在向导中添加各仓库路径，便于持续复用原料和发现历史任务。

### 6. 按向导选择并获取结果

**第一次使用、没有历史记录时**，向导直接进入新建：

```text
Agent：这次整理哪个业务中心？
你：订单中心
Agent：建议使用“订单中心（order-center）”。
       ① 采用建议
       ② 自定义英文目录标识
你：①

Agent：选择代码仓库
       ① 使用当前仓库（推荐）
       ② 添加或选择其他仓库
你：①

Agent：是否添加 PRD、ERD 等文档资料？
       ① 不添加，仅分析代码
       ② 添加文档资料（提供本地目录）
你：①

Agent：这次要整理哪个业务域？输入名称即可。
你：退款
Agent：建议目录标识为 refund。① 采用建议  ② 自定义标识
你：①

Agent：业务域边界说明：包含退款申请、审核和原路退回；
       不包含售后换货，订单支付只保留必要依赖。
       ① 采用这份边界
       ② 修改边界
你：①

Agent：知识库导出到哪里？
       ① 当前任务目录（推荐）：/work/project/code-knowledge/order-center/refund/
       ② 自定义目录
你：②，/work/knowledge

Agent：业务域：订单中心（order-center）/ 退款（refund）
       边界：申请、审核、原路退回；排除换货，支付仅保留依赖
       导出位置：/work/knowledge/code-knowledge/order-center/refund/
       开始分析。
```

选择由宿主提问工具呈现；没有该工具时，回复编号或名称。中心和业务域的命名选项会同时展示中文名称和建议英文目录标识，选用即可；已有英文名称会自动规范，不重复询问。**业务域名、业务域边界说明和导出位置都在向导中明确收集**；已提供的信息不重复询问。边界草案需要用户选择，不能把推荐当作已确认。

选择“自定义目录”输入的是导出根目录，系统会追加 `code-knowledge/<product-slug>/<domain-slug>/` 并展示最终路径。选择“当前任务目录”或回复“默认”即可使用推荐位置。新建原料时还会通过选择询问是否添加 PRD、ERD 等文档资料；选择添加后提供本地资料目录，选择不添加则仅分析代码。已明确提供资料或拒绝添加时不重复问，复用任务沿用原资料。

随后 Agent 准备原料、分析源码、汇总资产，校验通过后导出，并报告输出位置、核验范围、业务待审核与测试限制。元数据从真实材料生成，负责人未知为 null，不增加技术问卷。

默认结果位于启动 Agent 时的工作目录：

```text
code-knowledge/order-center/refund/
```

## 其他 Agent 的启动方式

在 Skill 项目目录执行对应注册命令，重新打开目标 Agent，再使用快捷入口：

| Agent | 注册命令 | 在 Agent 对话中输入 |
| --- | --- | --- |
| Claude Code | `npm run register -- --agent claude` | `/code2knowledge` |
| Codex | `npm run register -- --agent codex` | `$code2knowledge` |
| Cursor | `npm run register -- --agent cursor` | `/code2knowledge` |
| Gemini CLI | `npm run register -- --agent gemini` | `/code2knowledge` |
| GitHub Copilot（VS Code） | `npm run register -- --agent copilot --scope project --project /path/to/project` | `/code2knowledge` |

Codex 和 Claude Code 也可直接输入 `code2knowledge` 自然触发；未匹配时使用表中的明确入口。Copilot 使用项目级注册，并在目标项目的 Agent 模式中运行。

注册文件和脚本已通过本地测试；不同客户端版本的命令展示、自动匹配和完整分析流程仍需在对应环境验证。

## 日常使用

### 复用共享原料，整理其他业务域

在同一工作目录再次启动，向导根据实际记录显示：

```text
① 继续上次任务
② 复用共享原料，整理业务域
③ 新建业务中心或共享原料
```

选择“复用共享原料”，选中业务中心和原料，再指定新的业务域及范围。中心、仓库和资料信息自动带入，无需重复输入。新业务域仍会引导填写名称、边界说明和导出位置；只有一个原料候选时不重复选择。

复用前会检查仓库版本；版本变化或工作区未经核验时，可以选择刷新原料，已填的业务域信息会保留。新原料独立保存，旧任务继续关联原版本。

### 继续中断的任务

再次输入启动命令，选择“继续上次任务”。向导恢复已经填写的信息或已有分析进度，不重新填写完整问卷。也可以直接告诉 Agent 要继续的任务名称或运行目录。

历史记录只从当前或明确指定的工作区发现。换了工作目录，需要告诉 Agent 原工作区的位置。

### 一次提供完整需求

已有明确需求时，可以直接输入，跳过不必要的菜单：

```text
/code2knowledge 订单中心（order-center）的退款业务域（refund），仓库为 /work/order-api 和 /work/order-core。
整理申请、审核和原路退回，不含换货。
补充资料在 /work/docs，输出到 /work/knowledge。
```

Codex 将首行命令换为 `$code2knowledge` 即可。输出根目录为 `/work/knowledge` 时，最终业务域目录为 `/work/knowledge/code-knowledge/order-center/refund/`。

### 补充非代码资料

Markdown、文本、CSV、YAML 和 JSON 资料可直接保留。转换 Word、PDF、Excel、PPT 和 HTML 等格式时，需额外安装 [MarkItDown](https://github.com/microsoft/markitdown)：

```bash
python3 -m pip install 'markitdown[all]'
```

确保当前 Agent 能执行 `markitdown` 命令。实际格式支持取决于 MarkItDown 及相应转换依赖。

Repomix 默认启用，首次运行通过 npx 下载；安装和验证步骤见“准备代码打包与文档转换工具”。显式选择 source-index 时无需 Repomix。

## 产物与目录

共享原料归属于业务中心；每次业务域任务独立保存。目录使用中心和业务域的英文标识（`productSlug / domainSlug`），如 `order-center/refund`，仅允许小写英文字母、数字及单连字符。中文名称保留在文档标题和业务内容中，不作为这两级目录名。自定义导出根目录仍可包含中文。

```text
<工作目录>/
├── .code2knowledge/
│   ├── materials/<product-slug>/<原料版本>/  # 多仓库清单、资料、代码上下文
│   ├── runs/<运行编号>/             # 业务域草稿、计划与服务证据
│   └── wizards/<向导编号>.json      # 已填写的信息与选择
└── code-knowledge/
    └── <product-slug>/<domain-slug>/
        ├── ontology/               # 概念、代码节点和关系类型
        ├── domains/                # 带元数据的业务知识，规则/能力/流程各有权威定义
        ├── graph/curated/          # 经源码核验的代码图谱
        ├── mappings/               # 业务能力、规则到代码的映射
        └── rules/                  # 校验和持续维护约定
```

`domains/flows.yaml` 保存流程定义，`flows.md` 引用流程 ID 并保留检索上下文；`claims.yaml` 仅存额外风险与独立结论。规则详细定义只在 `domains/rules.yaml`。文件与条目的审核状态独立，`VERIFIED` 仅表示代码证据核验，默认业务审核 `pending`。

来源证据包含仓库、完整 commit、相对路径、符号、行号和支持的结论；导出后无需依赖内部工作区即可复查。类型约束与维护资料分别标记 `type_constraint / maintenance`，便于下游区分。

旧资产缺少 2.0 字段时会收到明确诊断，依据真实来源补齐后重新校验；不会使用当前 HEAD 冒充历史版本，也不自动认证旧成果。输出目录有草稿未包含的旧文件时，导出会停止，避免静默残留或删除历史知识。

旧任务如使用中文中心或域目录标识，请保留旧数据，按向导以英文标识新建任务；工具不会自动重命名旧目录或改写引用。

最终知识资产可以纳入 Git、文档站点或 RAG 平台，接入方需遵守 [下游接入契约](references/downstream-contract.md)，分块继承 ID、来源版本和条目状态；元数据不替代员工权限。提示词、问答记录、分析计划和 evidence 保留在工作区，不随最终资产导出。同名业务域已有输出时，向导会让用户选择更新或另取名称。

## 常见问题

**注册成功，为什么找不到命令？**

重新启动 Agent 会话，并确认注册时选择了正确的 Agent。项目级注册需要在对应项目中使用。可重新运行原注册命令；同一路径的注册支持重复执行。

**当前用户和项目级注册怎么选？**

个人使用一般选当前用户。只希望在特定项目可用时，明确指定目标项目：

```bash
npm run register -- --agent claude --scope project --project /path/to/project
```

省略 `--project` 会使用执行注册命令的工作目录，而不是自动识别待分析项目。`--dry-run` 可预览将创建的入口而不写文件。

**如何更新或卸载？**

更新本地项目后，在 Skill 目录重新安装依赖、注册，然后重新打开 Agent：

```bash
npm ci --ignore-scripts
npm run register -- --agent claude
```

将 `claude` 换为你使用的 Agent。移动项目目录后，应移除旧注册结果列出的本工具入口，再从新目录注册。工具不会覆盖来源不明的同名入口。卸载时只删除本工具的注册链接或命令文件，不删除整个 Agent 配置目录；工作项目中的知识资产和 `.code2knowledge` 数据独立保留。

**是否需要配置模型 API Key？**

使用当前 Agent 已配置的模型和权限，无需为本项目单独配置。分析产生的模型用量按宿主 Agent 的计费方式计算。

**校验通过是否代表业务结论完全正确？**

校验覆盖元数据、稳定 ID/引用、本体、证据字段、对应 commit 的文件与行号边界、来源一致性。符号目前检查非空，不做跨语言语义解析；调用语义、结论是否由证据支持、业务口径、人工审核身份与测试执行真实性仍需复核。凭证检查仅识别常见格式，不是完整安全扫描。无法确认的结论保留 `UNVERIFIED`。本项目不自动修改被分析源码或发布到外部平台。

## 从源码使用

下载完整项目后，在包含 `package.json` 和 `SKILL.md` 的目录执行：

```bash
npm ci --ignore-scripts
npm run register
```

源码注册入口指向本目录，应保留完整项目及依赖。移动目录后需移除旧入口并重新注册。npm 已发布首版 `1.0.0`，普通用户推荐使用 npm 全局安装；开发者可从本仓库安装源码。

## 开发与贡献

```bash
npm ci --ignore-scripts
npm test
npm run check
```

| 目录 | 用途 |
| --- | --- |
| `SKILL.md` | Agent 入口与执行规则 |
| `references/` | 向导、分析策略、格式与内部接口 |
| `scripts/` | 注册、发现、原料、骨架、校验及导出 |
| `assets/project-context/` | 本体与规则模板 |
| `test/` | 注册、向导和工作流测试 |

以下为维护者发布流程；npm 同一版本不可覆盖，修改后必须递增版本并更新 CHANGELOG。发布需有 `@code2knowledge` 权限：

```bash
npm login --registry=https://registry.npmjs.org
npm pack --dry-run
npm publish --access public --registry=https://registry.npmjs.org
```

`prepublishOnly` 会运行测试和语法检查。正式包仅包含入口、脚本、参考资料、本体模板、README 和许可证，不包含本地工作区或测试数据。

修改交互时同步更新 [向导协议](references/wizard.md)；修改脚本接口时同步更新 [执行接口](references/execution.md)，并运行相关测试。报告问题时请附 Agent 名称、Node.js 版本、复现步骤和脱敏后的错误信息。

## 许可证

采用 [MIT License](LICENSE)。继承的旧版代码和模板保留原许可声明，详见 [第三方及历史许可](THIRD_PARTY_NOTICES.md)。已发布的 1.0.0 仍采用原 ISC 协议。

默认代码上下文模式为 `repomix`，通过 `npx -y repomix` 执行；首次使用可能需要联网下载。显式设置 `contextMode: "source-index"` 可仅生成文件索引。已有向导与复用原料沿用已保存的模式。

### 正式逆向前检查 master

Agent 在生成代码原料及正式分析前，逐一检查所有依赖服务仓库，自动切换到 `master` 并执行从 `origin` 的快进拉取；只有 HEAD 与本次拉取的 `origin/master` 一致才继续。复用或续跑也检查，版本变化须刷新原料，保留旧证据。

有未提交改动、缺少 origin/master、分支分叉或本地领先、网络/权限等错误时，停止并请求人工介入。不会自动 stash、删除文件、强制覆盖或清除本地提交。此步骤已加入脚本门禁，底层准备命令同样自动同步 Git；失败记录保存在工作区 preflight/，启用飞书时尝试发送人工介入通知。

### 可选飞书通知

支持“需要人工介入”和“校验并导出成功”两类通知，默认关闭。在 `~/.code2knowledge/config.yml` 配置 `notification.feishu.enabled`、`webhook_url` 与可选 `secret` 后启用；不复用其他 skill 凭证。完成通知自动随导出触发，阻塞通知由 Agent 按协议调用。成功通知防重，发送结果保存在工作区 notifications/，失败不影响导出。配置和使用详见 [通知协议](references/notifications.md)。

安装 npm 包时自动初始化 `~/.code2knowledge/config.yml`（通知默认关闭、凭证为空）；注册 Agent 时也会补齐缺失模板。已有配置始终保留，不覆盖。使用 `--ignore-scripts` 安装会跳过安装钩子，但之后注册仍会生成模板。配置文件以仅当前用户可读写的权限创建。

## 从旧 Web 版迁移

1. 安装本 Skill 并注册到 Agent，无需运行旧 Web 服务、终端代理或配置额外模型密钥。
2. 保留旧 workspace 和已导出资产，明确告诉 Agent 原工作区的绝对路径。默认只发现当前目录的 `.code2knowledge/`，不会自动搜索旧数据。
3. 旧 material/run 可读取，但继续分析前会检查并更新 origin/master。源码版本变化需要生成新原料，不能用当前 HEAD 替代历史证据。
4. 旧资产缺少契约 2.0 元数据、来源指纹或英文目录标识时，需要按诊断补齐或新建任务；不保证无缝迁移，不自动改写、删除旧资产。

## 使用限制

- 分析使用宿主 Agent 的模型和权限。源码及资料会进入宿主模型上下文，请自行确认组织授权与数据使用范围。
- 默认会切换依赖仓库到 master 并快进同步 origin/master；没有该远程分支、脏代码、本地领先/分叉或认证失败时阻塞，不自动改用 main，不强制覆盖。
- 图片型 ERD、扫描 PDF 的图形关系不保证完整提取，建议提供文本化实体关系与规则。资料不能单独证明代码已经实现。
- 注册及脚本有自动化测试；不同 Agent 的 UI 表现、真实业务分析完整性仍需在目标环境验证。校验通过不是业务正确性或安全审计保证。
- 配置启用飞书意味着授权将任务摘要、任务标识和本机路径发送到机器人所在会话。测试默认隔离真实通知。
