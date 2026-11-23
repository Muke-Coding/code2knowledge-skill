---
knowledge_type: maintenance
---

# 知识维护规则

代码入口、数据表/字段、状态、MQ、配置、业务规则或边界变更时，按 evidence 与 mappings 定位受影响的规则、能力和流程。validate 的 impact 提供 repository/commit/path/symbol → knowledge_id/claim_id 关联。

刷新来源材料，重读受影响证据；保留稳定 ID。标记待复核 needs_review 并说明原因，不能继续作为当前 VERIFIED；废弃使用 deprecated，说明原因/替代 ID。删除前检查所有入向引用并审核 Git 差异，不自动提交。未受影响的事实也需核对新适用版本，不机械替换 commit。

一条规则的详细定义只维护在 domains/rules.yaml，流程/能力通过 ID 引用。更新原始条目后同步 Markdown 摘要与映射，避免重复定义漂移。来源或内容实质变化使既有人工审核指纹失效，应恢复 pending 或重新审核，Agent 不代替业务确认。

旧格式依据真实来源显式补齐，不编造元数据，不覆盖旧成果。导出遇到目标存在而草稿缺失的旧文件会停止；用户决定保留/标废弃或明确处理后再导出。

导出成功不等于审核通过或已发布。下游应继承元数据、逐条状态、来源及限制；系统标签不是员工权限。
