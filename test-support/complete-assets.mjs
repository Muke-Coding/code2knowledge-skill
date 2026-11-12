import fs from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { parseAsset, markdown } from "../scripts/lib/contract.mjs";

// Populate a small knowledge set whose facts can be checked against the real Git fixture.
export async function completeAssets(run) {
  const d = run.domainSlug;
  const cap = `CAP:${d}:refund`, rule = `RULE:${d}:positive`, concept = `CONCEPT:${d}:refund`, flow = `FLOW:${d}:refund`, risk = `CLAIM:${d}:risk`;
  const sources = run.repositories;
  const proof = (repo, supports) => ({ kind: "code", repository: repo.name, commit: repo.commit, path: "refund.js", symbol: "refund", lines: [1, 1], supports, node_id: `FUNC:${repo.name}:refund` });
  const claim = (supports, type = "code_fact") => ({ claim_type: type, status: sources.length ? "VERIFIED" : "UNVERIFIED", review_status: "pending", lifecycle: "current", evidence: sources.length ? sources.map((r) => proof(r, supports)) : run.contractContext.sources.filter((s) => s.kind === "document").map((s) => ({ ...s, locator: "金额规则", supports })), applicability: { conditions: ["调用 refund，金额为正数"], versions: sources.map((r) => `${r.name}@${r.commit}`), limitations: ["仅核实源码局部行为，未验证生产配置及完整业务口径"] } });
  const update = async (file, value) => {
    const old = parseAsset(file, await fs.readFile(path.join(run.draftsDir, file), "utf8"));
    await fs.writeFile(path.join(run.draftsDir, file), stringify({ meta: old.meta, ...value }));
  };
  const nodes = sources.map((r) => ({ id: `FUNC:${r.name}:refund`, type: "ServiceClass", service: r.name, path: `${r.name}/refund.js`, desc: "退款实现", evidence: [proof(r, "refund 拒绝非正数金额")] }));
  await update("domains/glossary.yaml", { terms: [{ id: `TERM:${d}:refund`, term: "退款", meaning: "返还金额", ...claim("源码包含退款实现", "business_rule") }] });
  await update("domains/concepts.yaml", { concepts: [{ id: concept, name: "退款", type: "process_entity", desc: "返还金额过程", related: [], ...claim("代码存在退款过程", "business_rule") }] });
  await update("domains/capabilities.yaml", { capabilities: [{ id: cap, name: "执行退款", desc: "返还金额", concepts: [concept], rules: [rule], ...claim("refund 实现执行退款") }] });
  await update("domains/rules.yaml", { rules: [{ id: rule, name: "金额为正", subject: "退款", severity: "high", desc: "非正数抛错", checked_scope: "refund 金额分支", ...claim("非正数金额触发异常", "business_rule") }] });
  await update("domains/flows.yaml", { flows: [{ id: flow, name: "退款局部处理", trigger: "调用 refund", scope: "退款金额检查与返回值，不包含外部支付", preconditions: ["调用者传入金额"], steps: ["检查金额", "返回 refunded"], data_changes: ["局部代码不持久化数据"], async_events: ["局部代码未包含异步事件"], failures: ["非正数抛错"], compensation: ["局部代码无副作用，无需回滚"], capabilities: [cap], rules: [rule], tests: { discovered: [], read: [], executions: [], limitations: ["未发现、阅读或执行测试；仅证明局部源码行为"] }, ...claim("refund 检查金额后返回结果") }] });
  await update("domains/claims.yaml", { claims: [{ id: risk, name: "生产调用链待确认", desc: "无法由局部函数证明生产环境完整退款行为", claim_type: "inference", status: "UNVERIFIED", review_status: "pending", lifecycle: "current", evidence: [], applicability: { conditions: ["生产部署"], versions: [], limitations: ["未读取部署配置及外部支付实现"] } }] });
  await update(`graph/curated/${d}.graph.yaml`, { nodes, edges: [] });
  const mapping = (key, id) => ({ [key]: id, graph_nodes: nodes.map((n) => n.id), evidence_refs: sources.map((_, index) => ({ claim_id: id, index })) });
  await update(`mappings/${d}.mapping.yaml`, { domain: d, capability_mappings: sources.length ? [mapping("capability_id", cap)] : [], rule_mappings: sources.length ? [mapping("rule_id", rule)] : [], flow_mappings: sources.length ? [mapping("flow_id", flow)] : [], entry_points: sources.length ? [{ node_id: nodes[0].id, capability_id: cap }] : [] });
  for (const [role, refs] of [["overview", [cap]], ["flows", [flow, rule]], ["pitfalls", [risk]]]) {
    const file = `domains/${role}.md`;
    const { meta } = parseAsset(file, await fs.readFile(path.join(run.draftsDir, file), "utf8"));
    await fs.writeFile(path.join(run.draftsDir, file), markdown(meta, `# 退款\n\n退款调用 refund 检查金额并返回状态；业务审核仍待完成。\n\n权威结论：${refs.join("、")}。金额规则详见 ${rule}，适用于本次来源版本。\n`, refs));
  }
  return { cap, rule, concept, flow, risk };
}
