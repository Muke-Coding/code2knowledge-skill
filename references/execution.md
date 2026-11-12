# Agent 执行接口

## 环境与路径

需要 Node.js 20+、Git。Skill 内核仅依赖 `yaml`；安装新项目时执行一次 `npm ci --ignore-scripts`（在 Skill 目录）。若缺少依赖，先按宿主权限执行安装；不能联网时说明阻塞，不安装 Web/终端依赖。需要资料转换时才检测 `markitdown`；需要 Repomix 时才调用 `npx -y repomix`。

### 配套工具安装与告知

npm 安装 Skill 或执行 npm ci 只安装包声明的依赖，不代表 Repomix、MarkItDown 已就绪。首次实际使用前先检测；有缺失时简短告知用户“将配套安装本次所需工具：Repomix 由 npm/npx 下载，文档转换器 MarkItDown 由 Python/pip 安装”，然后在已授权任务范围和宿主权限内执行，不无故增加确认环节。仅在确有权限/环境限制时说明阻塞，不宣称已安装。

- 默认 Repomix：执行 `npx -y repomix --version` 验证并按需下载到 npm 缓存，后续打包仍用 npx；无需全局安装，也不要安装到被分析仓库的 package.json。
- 需要转换非文本资料时：先检测 `markitdown --version`。缺失则用 `python3 -m venv ~/.local/share/code2knowledge-tools` 建立独立环境，再用该环境的 Python 执行 `-m pip install 'markitdown[all]'`；将其 bin 目录加入当前执行环境 PATH，保证后续 knowledge.mjs 能找到 markitdown。已有可用安装直接复用。不要覆盖系统 Python；Python 或特定格式系统依赖缺失时报告真实问题。
- 安装后验证对应命令，报告实际结果；仅 Markdown/TXT/CSV/YAML/JSON 无需 MarkItDown，source-index 模式无需 Repomix。首次下载需要网络，不能联网时保留向导并说明阻塞，不能静默丢弃资料或降级模式。

设 `SKILL` 是读取本文件的 Skill 绝对路径，`PROJECT` 是任务启动目录，`WORKSPACE` 默认 `PROJECT/.code2knowledge`。脚本参数以独立参数传递，路径包含空格也必须正确引用。不要用用户输入拼接 shell 代码。每次命令明确传 `--workspace`，续跑保持相同值。

## 准备原料前：选择分析分支并安全同步

master 是缺省推荐值，不是必须使用的分支。Agent 先只读查看仓库当前分支、origin/HEAD 和已有分支，再用结构化选择询问分析分支，提供 master、实际 main/默认分支及自定义入口；用户已明确指定时不重复问。没有 master 的仓库推荐实际默认分支，不因没有 master 要求人工修复。仅文档任务跳过。

输入支持 `branch: "main"` 设置所有仓库公共目标，也支持 `branches: {"/absolute/service-a": "release/v2", "/absolute/service-b": "main"}` 逐仓覆盖。未传 branch 时底层缺省 master，以兼容旧调用；这不是拒绝其他分支的限制。Agent 必须先说明并保存用户选定分支，不静默切换。相对仓库路径在向导中解析为绝对路径。

脚本先检查全部工作区 clean 和未完成 Git 操作；然后逐仓 fetch origin 的选定分支、检查快进可行性、切换本地分支（缺失时建立远程跟踪分支）、pull --ff-only，核对 HEAD 与 origin/<选定分支> 一致。选定分支不存在、脏代码、本地领先/分叉、认证或网络失败时停止，不 stash、reset、强制覆盖或删除提交。重新选择可用分支不属于失败绕过；必须重新准备对应原料。

prepare/material、domain 和 wizard-start 的准备/复用/恢复路径均执行同步检查。记录保存到工作区 preflight/，每仓包含目标分支、原分支及 commit、同步后 commit 与结果；失败时启用的通知会尝试请求人工介入。用户处理后重新检查，已经更新的仓库不自动回滚。

原料保存 branch、branches 和 preflight。复用或恢复沿用该原料的分支，历史无字段记录缺省 master；Agent 应展示并允许用户选择改分支、创建新原料。同步后 commit 改变则原料过期，禁止用新 HEAD 冒充历史证据。

## 选择向导接口（优先使用）

```bash
node "$SKILL/scripts/knowledge.mjs" discover --workspace "$WORKSPACE"
```

返回当前仓库候选、菜单、业务中心、最近原料、未完成任务和问答检查点。默认各取最近 8 项，`totals` 表示完整数量。需要更多原料用 `list`，更多任务用 `runs`。发现阶段不核查全部仓库版本，原料的 `freshness: unchecked` 不能解释为可复用。

将用户选择与已有信息写到工作区内临时 JSON，再调用 `wizard --input FILE` 保存：

```json
{
  "intent": "reuse",
  "materialDir": "/absolute/path/.code2knowledge/materials/order-center/<版本>",
  "answers": {
    "domainName": "退款",
    "domainSlug": "refund"
  }
}
```

`intent` 为 `new`（新建原料并整理域）、`reuse`（引用已有原料整理域）、`resume`（继续已有 run）、`material`（仅准备原料）。已有 run 用 `runDir`，已有原料用 `materialDir`。

```bash
node "$SKILL/scripts/knowledge.mjs" wizard --input "$WORKSPACE/answer.json" --workspace "$WORKSPACE"
```

结果返回 `wizardId`、`wizardPath`、已填 `answers`、`missingFields`、`nextStep`、`status`；英文标识和输出位置齐全时返回 `exportDirPreview`，用于展示最终路径。后续传同一个 `wizardId`，仅补新增答案，不需要重复传全部参数：

```json
{
  "wizardId": "<返回的编号>",
  "answers": {
    "domainScope": "包含退款申请、审核和原路退回；排除售后换货，支付仅保留依赖",
    "outputRootDir": "/absolute/path/project"
  }
}
```

复用时中心/仓库及资料自动从 material 带入。新建原料时必须先完成“是否添加文档资料”的结构化选择；选择添加后收集本地目录写入 rawDocsDir，选择不添加才保存空字符串，不能把默认空值或 missingFields 为空视为已经回答。业务域名、边界说明和导出位置通过向导明确收集，outputRootDir 只有用户选定后才保存，不能直接复制发现接口的推荐值冒充选择。收集导出位置必须沿用宿主结构化选择工具，提供推荐目录与自定义入口；普通文本编号只用于工具确实不可用的兜底，详细规则见 wizard.md。rawDocsDir 必须显式提交：不添加传空字符串，添加传目录；新向导缺少它时 missingFields 返回 rawDocsDir，启动及底层原料创建均拒绝缺省值。`answers` 仅支持 `productName`、`productSlug`、`domainName`、`domainSlug`、`domainScope`、`repoDirs`、`rawDocsDir`、`outputRootDir` 、`branch`、`branches` 和 `contextMode`；repoDirs 为路径数组，branches 为仓库绝对路径到分支名的对象，其余为文本。中文名称需由 Agent 在命名选择中一并推荐英文标识，用户选用后保存；纯英文名称可自动规范为小写连字符标识。缺少中文名称对应的英文标识时，missingFields 会返回 productSlug / domainSlug，禁止猜测翻译后直接开始。

```bash
node "$SKILL/scripts/knowledge.mjs" wizard --wizard "$WIZARD_ID" --workspace "$WORKSPACE"
node "$SKILL/scripts/knowledge.mjs" wizard-start --wizard "$WIZARD_ID" --workspace "$WORKSPACE"
```

`wizard-start` 仅允许 `ready`，复用前检查仓库版本；失败保留问答。成功返回 `wizard` 与 `result`，后者为 material 或 run 的准备结果，包含草稿/提示词/证据路径。向导标记 `started` 并关联任务；再次调用返回同一任务（`alreadyStarted: true`），不重新准备。Agent 接着分析，不能把这个状态视为分析完成。普通任务按顺序调用；创建途中进程异常时先用 `discover` 检查已经生成的 run，避免另建重复任务。

需要刷新选定原料时，用同一个 wizardId 保存 `intent: new`，已有中心、仓库、域名和范围继续保留。版本检查器同时核对仓库与已记录资料指纹；Agent 仍需核对转换结果和资料语义是否完整。

## 底层输入（完整参数或特殊流程）

底层命令继续保留，通常由向导代办；已通过向导创建任务后不能重复调用。完整输入示例：

```json
{
  "productName": "订单中心",
  "productSlug": "order-center",
  "domainName": "退款",
  "domainSlug": "refund",
  "domainScope": "退款申请、审核和原路退回，不含售后换货",
  "repoDirs": ["/absolute/path/order-api", "/absolute/path/order-core"],
  "rawDocsDir": "",
  "outputRootDir": "/absolute/path/project",
  "contextMode": "repomix"
}
```

字段来自用户或已说明的默认值；英文目录标识随名称选项一并确定，不另开技术字段问卷；不要逐项提问 contextMode 等参数。目录标识必须匹配 `[a-z0-9]+(?:-[a-z0-9]+)*`。默认启用 repomix，通过 `npx -y repomix` 生成代码上下文（首次调用可能需要联网下载）；显式设置 contextMode 为 source-index 时仅创建文件列表，由 Agent 后续定向读取源码。复用原料或继续向导时沿用已有模式。

## 命令

以下是 Agent 内部工具，用户日常只需输入启动词。

```bash
node "$SKILL/scripts/knowledge.mjs" list --workspace "$WORKSPACE"
node "$SKILL/scripts/knowledge.mjs" prepare --input "$WORKSPACE/request.json" --workspace "$WORKSPACE"
```

stdout 仅为 JSON；日志默认关闭，`C2K_VERBOSE=1` 时日志写 stderr。成功结果包含 `contractContext`（真实来源及程序时间，metadata 的生成上下文）、`materialDir`、`runDir`、`draftsDir`、`promptPath`、`analysisPlanPath`、`evidenceDir` 和导出目标。读取这些返回值，不能猜时间戳路径。

需要复用时，先找同产品、同仓库、同资料的 material，核对路径、contextMode、资料是否变化，再执行：

```bash
node "$SKILL/scripts/knowledge.mjs" check --material "$MATERIAL" --workspace "$WORKSPACE"
```

只有所有仓库 commit 相同且记录时/当前均为 clean，返回 `reusable: true`。同时检查已记录资料的 SHA-256、新增资料及不可读文件；转换质量仍需 Agent 复核。有变化生成新原料，不能修改旧 material 冒充原版本。

复用时输入改为 `materialDir` 加业务域名称、英文标识、范围和输出目录，执行 `domain`。需要只准备原料执行 `material`。`prepare` 同时完成原料与业务域骨架准备，也接受 `materialDir`。

```bash
node "$SKILL/scripts/knowledge.mjs" domain --input "$WORKSPACE/request.json" --workspace "$WORKSPACE"
node "$SKILL/scripts/knowledge.mjs" status --run "$RUN" --workspace "$WORKSPACE"
node "$SKILL/scripts/knowledge.mjs" validate --run "$RUN" --workspace "$WORKSPACE"
node "$SKILL/scripts/knowledge.mjs" export --run "$RUN" --workspace "$WORKSPACE" --output "$OUTPUT"
```

失败返回非零退出码；校验失败仍输出 JSON 诊断，不能因退出码非零而忽略诊断。`export` 每次重新校验，不能靠历史 `validated` 状态绕过。只导出五个资产目录，不带提示词、分析计划和原始 evidence；整理后的证据必须包含在最终业务条目/图谱中，不含机器绝对路径。目标有草稿未包含的旧文件时阻止导出，不静默删除或残留旧成果。

## 续跑与旧数据

用户提供 run 路径时，工作区是该路径的 `runs` 的父目录。先读取 `status`、原料、分析计划和各服务 evidence。核对 commit、范围和文档变化，只重读受影响证据。更新计划中的阶段状态，不能只根据进程成功或文件存在认为完成。

旧 Web 项目的 material/run 格式仍可读取：`--workspace` 指向旧 `workspace` 即可；缺少工作区状态的历史材料只能做结构校验，应在报告中说明并重新核实源码。不要自动迁移、覆盖或清理原项目。旧记录中的中文中心/域标识仍可读取，但不能继续生成新域或导出到中文标识目录；保留旧数据，使用英文标识新建任务，不能只重命名目录而遗漏图谱、映射和引用。

## 契约上下文与历史补齐

新任务的 run.json 与准备结果包含 contractContext：schema_version、product/domain、generated_at、systems、sources、已知 identities。模板直接由这些真实值生成，不能临时猜时间、版本和审核信息。来源资料的 document_id/path/sha256 来自原料清单；复用核查原资料指纹。

旧任务没有上下文时，保持读取和恢复能力。先读取原料记录；从真实来源确认分析版本/资料指纹，再手工补齐现有文件的 frontmatter/meta、业务 ID、逐条状态、证据与引用。无法核实的来源明确未知或刷新原料重新分析，不能用当前 HEAD 代替历史版本。工具不会自动填造旧元数据、批量覆盖旧文件或将旧格式直接标为满足 2.0。

## 校验边界

程序检查 Markdown frontmatter/业务 YAML meta 类型、ID 唯一性及引用、条目类型与状态、VERIFIED 证据完整性、来源材料一致性、对应 commit 中的文件与行号边界、人工审核记录结构与内容指纹、本体约束、映射及入口引用。validate 返回 contractVersion、assets、impact、errors/warnings 和 sourceCheck；impact 为来源代码到业务 ID 的关联，原始 evidence 不导出。

中心查重覆盖当前资产及指定输出根目录下可读取的同中心其他业务域，不覆盖未知知识库或历史快照。dirty/unknown 限制按结论实际引用仓库判断；缺测试执行记录需说明覆盖限制，不否定已有局部源码事实。

符号仅检查非空；程序不自动证明调用语义、SQL 语义、规则正确性、行号是否足以支持结论、审核人身份或测试真实运行。常见绝对路径/认证 URL/凭证模式检查不是完整泄漏扫描。Agent 必须继续做证据语义复核；通过结构校验不等于业务审核或发布。

## 通知

人工介入使用 `notify --input FILE --workspace DIR`，输入和触发条件见 [通知协议](notifications.md)。export 成功后自动返回 notification 结果；仅 status=sent 为已确认发送。通知配置默认关闭。
