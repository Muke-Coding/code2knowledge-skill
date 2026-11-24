---
schema_version: "2.0"
knowledge_id: K:fixture:refund:flows
product: fixture
domain: refund
systems:
  - fixture-core
knowledge_type: flows
generated_at: 2026-11-20T11:18:23.321Z
review_status: pending
owner: null
lifecycle: current
sources:
  - kind: code
    repository: fixture-core
    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    worktree_status: clean
claim_refs:
  - FLOW:refund:refund
  - RULE:refund:positive
---

# 退款

退款调用 refund 检查金额并返回状态；业务审核仍待完成。

权威结论：FLOW:refund:refund、RULE:refund:positive。金额规则详见 RULE:refund:positive，适用于本次来源版本。
