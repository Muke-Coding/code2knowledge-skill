---
knowledge_type: type_constraint
---

# 代码知识图谱本体

本体用于约束业务语义、代码事实以及二者之间的映射。业务域是知识维护和检索单元，一个业务域可以跨多个微服务。

## 四层模型

1. `ontology`：定义概念类型、代码节点类型、关系类型和属性约束。
2. `domains`：维护术语、业务概念、能力、规则、流程和经验风险。
3. `graph/curated`：维护可由源码验证的代码节点、关系和事实判定。
4. `mappings`：把业务概念、能力和规则映射到代码入口、表、MQ 与外部系统。

## 业务概念

业务概念必须使用 `concept-types.yaml` 中定义的类型。概念不是 Java 类名，而是产品、开发和测试共同使用的业务语义。每个 capability 至少关联一个 concept；concept 的 `related` 只能引用已定义概念。

## 代码事实

代码节点必须符合 `node-types.yaml` 的必填属性，关系必须符合 `relation-types.yaml` 的方向和端点约束。带 `path` 的节点必须能在对应仓库中找到真实文件。

## 分层边界

- 可从代码重新验证的内容进入 `graph/curated`。
- 业务口径、流程说明和历史经验进入 `domains`。
- 业务到代码的定位关系进入 `mappings`。
- 推断必须标记为 `UNVERIFIED`，不得伪装成代码事实。

## 知识契约 2.0

业务 Markdown 使用 frontmatter，业务 YAML 使用 meta，包含稳定 knowledge_id、product/domain/systems、sources、生成时间与审核状态。类型约束与维护资料仅标识自身角色，不能伪装成业务事实。

规则、能力、流程、概念、术语和独立结论分别维护稳定业务 ID，声明 claim_type、代码核验 status、人工 review_status、lifecycle、适用条件/版本/限制及结构化证据。推断不能 VERIFIED，默认审核 pending。流程与文档引用规则 ID，不复制权威规则定义。

VERIFIED 关键证据需仓库、完整 commit、相对路径、符号、有效行号与支持结论。业务资料证据需真实内容指纹与定位，不能单独证明代码实现。结构通过不证明语义或人工审核真实性。
