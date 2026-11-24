# 知识资产契约 2.0

Code2Knowledge 是知识生产层：源码/资料 → Code2Knowledge → Git 知识资产 → 文档站/RAG → MCP → 员工 Agent。只负责本地知识生产与交付，不实现下游服务，不自动提交 Git、部署或发布。结构通过、代码核验、业务审核和员工发布是不同事件。

## 五个目录与权威定义

- `ontology/`：类型约束，`knowledge_type: type_constraint`。
- `domains/`：业务 Markdown 和业务 YAML。
- `graph/curated/<domain>.graph.yaml`：核实存在的代码节点与关系。
- `mappings/<domain>.mapping.yaml`：规则/能力/流程到代码的关联。
- `rules/`：维护资料，`knowledge_type: maintenance`；不是业务规则定义。

业务规则详细定义只在 `domains/rules.yaml`；能力在 `capabilities.yaml`；概念在 `concepts.yaml`；术语在 `glossary.yaml`（条目也需 id）。`flows.yaml` 保存权威流程，`flows.md` 给出带 ID 和业务背景的阅读摘要。`claims.yaml` 仅维护其他集合无法表达的风险/独立结论，不能复制已有规则。三个 Markdown 为 `overview.md / flows.md / pitfalls.md`。

## 文件元数据

业务 Markdown 使用 YAML frontmatter；业务 YAML 使用顶层 `meta`，不可在 YAML 外包 Markdown 分隔符。业务 YAML 包括 domains、graph 和 mappings。最低字段：

```yaml
schema_version: "2.0"
knowledge_id: K:order-center:refund:business_rules
product: order-center
domain: refund
systems: [order-api, order-core]
knowledge_type: business_rules
generated_at: <程序生成的真实 ISO 时间>
review_status: pending
owner: null
lifecycle: current
sources:
  - kind: code
    repository: order-api
    commit: <原料记录的完整 Git commit>
    worktree_status: clean
  - kind: code
    repository: order-core
    commit: <原料记录的完整 Git commit>
    worktree_status: clean
```

示意占位值不能直接用于交付。每份业务资产保留本次所有仓库来源，不能用单个 source_commit 代替。commit 为完整 40/64 位小写十六进制；非 Git/不可获取时为 `null`，相关结论不能 VERIFIED。工作区状态为 `clean/dirty/unknown`。sources 不写仓库绝对路径、认证 URL 或凭证。

资料来源使用 `kind: document`、`document_id`、原资料相对 `path`、真实内容 `sha256`。原料准备时程序计算指纹并记录；不能用文档更新时间推测版本。没有代码仓库的资料分析允许 `systems: []`，但 sources 不能空。

knowledge_type 为 `overview / flows / pitfalls / business_note / glossary / concepts / capabilities / business_rules / flow_definitions / claims / code_graph / code_mappings`。维护资料只要求明确角色，不伪装业务审核元数据。

业务 Markdown 另有 `claim_refs: [稳定业务 ID]`，引用权威条目。关键结论不能只写自由正文而遗漏结构化条目；每个可检索小节写出业务对象、条件、行为、版本或限制，不能只写“按上述规则”。程序检查引用存在，不证明自然语言摘要忠实于权威定义。

## 稳定标识

knowledge_id 标识文件承载的知识，业务 id 标识概念/能力/规则/流程/结论。两者不由时间戳、内容 hash 或当前文件路径生成。新资产初始 knowledge_id 为 `K:<product>:<domain>:<知识类型>`；重新整理已有域时，程序读取已有导出元数据按知识类型沿用 ID。自定义同类文档需分配独立稳定 ID；移动文件保留 ID，不能重编。

业务 ID 保留现有 `CONCEPT:/CAP:/RULE:` 形式，增加 `TERM:/FLOW:/CLAIM:`，同中心唯一。更新前读取已有资产并保留其语义 ID；不能通过改 ID 绕开历史引用。中心级程序查重只覆盖本次资产和所选输出根目录下可读取的同中心其他业务域，不声称检查整个企业。跨域引用登记 `external_references: [{id, knowledge_id, domain}]`；登记只明确来源，不代表自动验证外部资产内容。

## 条目契约与审核

术语、概念、能力、规则、流程和独立结论均包含：

```yaml
id: RULE:refund:positive-amount
claim_type: business_rule  # code_fact / business_rule / inference
status: UNVERIFIED        # 代码证据状态
review_status: pending    # pending / confirmed / rejected
lifecycle: current        # current / needs_review / deprecated
applicability:
  conditions: []
  versions: []
  limitations: [尚未核验实现]
evidence: []
```

VERIFIED 必须有完整代码证据及非空适用版本，inference 不能 VERIFIED。UNVERIFIED 必须说明限制。业务资料能证明“文档记载该规则”，不能单独证明代码实现。文档/条目审核分别记录，整篇审核状态不能替代条目状态；默认全部 pending，owner 未知为 null。

Agent 不自动 confirmed/rejected。仅在用户提供真实人工审核依据时记录 `review: {reviewer, reviewed_at, basis, content_sha256}`。指纹由 `scripts/lib/contract.mjs` 的 `contentHash` 计算，排除 generated_at/review/review_status，包含来源版本与实质内容；文件审核覆盖完整 YAML 或 Markdown 的 `{meta, body}`，条目审核覆盖原条目。修改内容/来源后旧指纹失效，需重新审核或恢复 pending。程序只能验证结构和指纹，不能认证审核人身份或审批真实性。

## 可交付证据

```yaml
evidence:
  - kind: code
    repository: order-core
    commit: <真实完整 commit>
    path: src/RefundService.java
    symbol: RefundService#apply
    lines: [80, 120]
    supports: 非正数金额进入参数异常分支
    node_id: FUNC:order-core:refund-apply  # 可选，存在时必须对应同一代码路径
```

证据 path 为仓库内相对路径；图谱节点继续使用 `<repository>/<relative-path>`。程序检查仓库来源、版本、符号非空、行号有效且不越过对应 commit 的文件，不能证明符号真是该语言的定义或行号内容足以支持结论。

资料证据使用 `kind/document_id/path/sha256/locator/supports`，对应 sources 中的资料；locator 是章节/页码等可复查位置。最终资产不能只写内部 EVIDENCE ID 或临时路径。

图谱带 path 节点附代码 evidence，代码关系需 `status: VERIFIED` 和 evidence；未确认关系进入 claims。能力/规则/流程映射分别用 `capability_id/rule_id/flow_id`、`graph_nodes`、`evidence_refs: [{claim_id, index}]`，index 为该权威条目 evidence 的零起始索引。避免再次复制规则定义或维护第二套证据。

VERIFIED 能力、high 规则、流程需要映射；资料中的未实现规则允许不映射。提供的映射必须引用真实节点和该条目的有效证据。

## 流程与测试

flows 条目还需 `name/trigger/scope`，以及文本列表 `preconditions/steps/data_changes/async_events/failures/compensation`。确实无适用项时明确说明原因，不编造异步事件或补偿。

`tests.discovered/read` 分别记录发现和阅读的测试；`executions` 记录实际 `command/executed_at/exit_code/result`；`limitations` 说明覆盖范围。未运行时 limitations 不能为空。发现测试、阅读测试、执行通过不可相互替代，也不能因无测试否定源码已证明的局部事实。

## 更新与追溯

evidence 和 mappings 共同提供来源代码 → 规则/能力/流程关联，validate 另返回 `impact` 便于定位影响。来源变化后刷新原料并重读受影响结论，标记 needs_review；废弃用 deprecated 并说明替代关系/原因，不能继续 VERIFIED。删除前检查入向引用并由 Git 变更审核，工具不自动提交。

导出不静默清理旧文件：目标存在而草稿缺失的文件会阻止导出，需显式保留/标废弃或由用户授权处理。旧格式保持可读、可续跑，必须依据真实来源补齐后满足新契约；不得用当前 HEAD 冒充历史版本，也不得自动覆盖旧资产。
