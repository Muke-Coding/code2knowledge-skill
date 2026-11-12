import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parse, stringify } from "yaml";

export const schemaVersion = "2.0";
export const assetDirs = ["ontology", "domains", "graph", "mappings", "rules"];
export const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && !!v.trim();
const array = (v) => Array.isArray(v) ? v : [];
const list = (v) => Array.isArray(v) && v.every(text);
const date = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= Date.now() + 60000;
const relative = (v) => text(v) && !path.posix.isAbsolute(v) && !/^[A-Za-z]:|\\|[\x00-\x1f]/.test(v) && v.split("/").every((p) => p && p !== "." && p !== "..");
export const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

// Exclude audit fields, but include source versions and substantive content in review fingerprints.
export function contentHash(value) {
  const clean = (v) => Array.isArray(v) ? v.map(clean) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => !["review", "review_status", "generated_at"].includes(k)).map((k) => [k, clean(v[k])])) : v;
  return sha256(JSON.stringify(clean(value)));
}

export function sourceRecords(repositories = [], documents = []) {
  return [
    ...repositories.map((r) => ({ kind: "code", repository: r.name, commit: fullCommit.test(r.commit || "") ? r.commit : null,
      worktree_status: r.worktreeStatus || "unknown" })),
    ...documents.map(({ document_id, path: file, sha256: digest }) => ({ kind: "document", document_id, path: file, sha256: digest })),
  ];
}

export function makeContext({ product, domain, repositories = [], documents = [], identities = {}, generatedAt = new Date().toISOString() }) {
  return { schema_version: schemaVersion, product, domain, generated_at: generatedAt,
    systems: repositories.map((r) => r.name), sources: sourceRecords(repositories, documents), identities };
}

export function metadataFor(context, type) {
  return { schema_version: schemaVersion, knowledge_id: context.identities?.[type] || `K:${context.product}:${context.domain}:${type}`,
    product: context.product, domain: context.domain, systems: [...context.systems], knowledge_type: type,
    generated_at: context.generated_at, review_status: "pending", owner: null,
    lifecycle: "current", sources: structuredClone(context.sources) };
}
export function pendingClaim(type = "code_fact") {
  return { claim_type: type, status: "UNVERIFIED", review_status: "pending", lifecycle: "current", evidence: [],
    applicability: { conditions: [], versions: [], limitations: [] } };
}
export function markdown(meta, body, refs = []) {
  return `---\n${stringify({ ...meta, claim_refs: refs })}---\n\n${body}`;
}

export function parseAsset(file, content) {
  if (/\.md$/i.test(file)) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error("缺少 YAML frontmatter；请按 references/knowledge-model.md 补齐，不能将旧资产直接认证为新契约");
    const meta = parse(match[1]);
    return { meta, body: content.slice(match[0].length), value: { meta, body: content.slice(match[0].length) } };
  }
  const value = parse(content);
  if (!object(value)) throw new Error("YAML 顶层必须为对象，业务字段使用顶层 meta");
  return { meta: value.meta, value };
}

// Reject symlinks rather than letting an exported asset escape the selected five directories.
export async function assetFiles(root, dirs = assetDirs) {
  const result = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const entry of entries) {
      const file = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`知识资产不允许符号链接：${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(file);
    }
  }
  for (const dir of dirs) await walk(dir);
  return result.sort();
}

export async function existingIdentities(root) {
  const ids = {};
  for (const file of await assetFiles(root)) {
    if (!/\.(md|ya?ml)$/i.test(file) || /^(ontology|rules)\//.test(file)) continue;
    try {
      const { meta } = parseAsset(file, await fs.readFile(path.join(root, file), "utf8"));
      if (text(meta?.knowledge_type) && text(meta?.knowledge_id)) {
        if (ids[meta.knowledge_type] && ids[meta.knowledge_type] !== meta.knowledge_id) continue;
        ids[meta.knowledge_type] = meta.knowledge_id;
      }
    } catch { /* Legacy assets are read as legacy, never silently upgraded. */ }
  }
  return ids;
}

function reviewErrors(value, label, errors, fingerprintValue = value) {
  if (!["pending", "confirmed", "rejected"].includes(value.review_status)) errors.push(`${label}.review_status 必须为 pending/confirmed/rejected`);
  if (value.review_status !== "pending" && ["confirmed", "rejected"].includes(value.review_status)) {
    const r = value.review;
    if (!object(r) || !text(r.reviewer) || !date(r.reviewed_at) || !text(r.basis) || r.content_sha256 !== contentHash(fingerprintValue)) {
      errors.push(`${label} 人工审核缺少真实依据或内容指纹已变化：需要 review.reviewer/reviewed_at/basis/content_sha256；重新核实后填写，默认保持 pending`);
    }
  }
}

// Only checks recognizable accidental disclosures; not a credential or privacy certification.
function portable(content, label, errors) {
  if (/(?:\/(?:Users|home|private\/var|var\/folders|tmp|Volumes)\/[^\s"'<>]+|[A-Za-z]:\\[^\s]+)/.test(content)) errors.push(`${label} 包含机器绝对路径`);
  if (/https?:\/\/[^\s/]+@|[?&](?:access_token|token|api_key|password)=|(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/i.test(content)) errors.push(`${label} 包含认证 URL 或疑似凭证`);
  if (/(?:\.code2knowledge\/|(?:^|[\s"'(])(?:\.\.\/)?evidence\/|AI_PROMPT\.md|analysis-plan\.yaml|EVIDENCE:)/m.test(content)) errors.push(`${label} 引用内部证据或临时工作区；请将整理后的证据写入最终资产`);
}

export async function validateContract(root, options = {}) {
  const errors = [], warnings = [], assets = [], claims = new Map(), knowledgeIds = new Map(), nodes = new Map(), impact = [];
  const fail = (label, message) => errors.push(`${label}：${message}`);
  let files;
  try { files = await assetFiles(root); }
  catch (e) { return { errors: [e.message], warnings, assets: [], impact: [] }; }
  for (const file of files) {
    if (!/\.(md|ya?ml)$/i.test(file)) { fail(file, "只支持 Markdown/YAML 知识资产"); continue; }
    const content = await fs.readFile(path.join(root, file), "utf8");
    portable(content, file, errors);
    if (/^(ontology|rules)\//.test(file)) {
      try {
        const expected = file.startsWith("ontology/") ? "type_constraint" : "maintenance";
        const role = parseAsset(file, content).meta?.knowledge_type;
        if (role !== expected) fail(file, `维护资料需明确 meta/frontmatter.knowledge_type: ${expected}`);
      } catch (e) { fail(file, e.message); }
      continue;
    }
    let asset;
    try { asset = { file, ...parseAsset(file, content) }; }
    catch (e) { fail(file, e.message); continue; }
    assets.push(asset);
    const m = asset.meta;
    if (!object(m)) { fail(file, "缺少 meta；旧资产需按知识契约补齐，不自动填造元数据"); continue; }
    if (m.schema_version !== schemaVersion) fail(file, `schema_version 必须为字符串 ${schemaVersion}；旧任务可续跑，资产需显式补齐`);
    for (const k of ["knowledge_id", "product", "domain", "knowledge_type"]) if (!text(m[k])) fail(file, `缺少文本元数据 ${k}`);
    for (const k of ["product", "domain"]) if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m[k] || "")) fail(file, `${k} 必须为英文目录标识`);
    if (options.run && (m.product !== options.run.productSlug || m.domain !== options.run.domainSlug)) fail(file, "product/domain 与任务不一致");
    if (!list(m.systems) || new Set(m.systems).size !== m.systems?.length) fail(file, "systems 必须为不重复的服务标识列表");
    if (!date(m.generated_at)) fail(file, "generated_at 必须为真实 ISO 时间，不能为未来时间");
    if (!(m.owner === null || text(m.owner))) fail(file, "owner 必须为文本或 null，未知不得编造");
    if (!["current", "needs_review", "deprecated"].includes(m.lifecycle)) fail(file, "lifecycle 必须为 current/needs_review/deprecated");
    reviewErrors(m, `${file}.meta`, errors, asset.value);
    if (knowledgeIds.has(m.knowledge_id)) fail(file, `knowledge_id 重复：${m.knowledge_id}（${knowledgeIds.get(m.knowledge_id)}）`);
    knowledgeIds.set(m.knowledge_id, file);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(m.knowledge_id || "")) fail(file, "knowledge_id 必须为稳定标识，不能包含文件路径或空格");
    const types = { glossary: "terms", concepts: "concepts", capabilities: "capabilities", business_rules: "rules", flow_definitions: "flows", claims: "claims", code_graph: "nodes", code_mappings: "capability_mappings" };
    if (!["overview", "flows", "pitfalls", "business_note", ...Object.keys(types)].includes(m.knowledge_type)) fail(file, "knowledge_type 未定义");
    if (m.knowledge_type === "code_graph" && m.verified_commits !== undefined) {
      if (!object(m.verified_commits)) fail(file, "verified_commits 必须为仓库到完整 commit 的映射");
      else for (const [repo, commit] of Object.entries(m.verified_commits)) if (!array(m.sources).some((s) => s?.kind === "code" && s.repository === repo && s.commit === commit && s.worktree_status === "clean") || !fullCommit.test(commit)) fail(file, `verified_commits 与代码来源不一致：${repo}`);
    }
    if (types[m.knowledge_type] && !Array.isArray(asset.value[types[m.knowledge_type]])) fail(file, `YAML 结构错误：${types[m.knowledge_type]} 必须为对象列表`);
    if (asset.value.domain !== undefined && asset.value.domain !== m.domain) fail(file, "顶层 domain 与 meta.domain 不一致");
    if (!Array.isArray(m.sources) || !m.sources.length) { fail(file, "缺少来源 sources（允许仅有业务资料来源）"); continue; }
    const sourceKeys = new Set();
    for (const source of m.sources) {
      if (!object(source)) { fail(file, "sources 必须为对象列表"); continue; }
      const key = source.kind === "code" ? `code:${source.repository}` : `document:${source.document_id}`;
      if (sourceKeys.has(key)) fail(file, `来源重复：${key}`);
      sourceKeys.add(key);
      if (source.kind === "code") {
        if (!text(source.repository) || !(source.commit === null || fullCommit.test(source.commit || "")) || !["clean", "dirty", "unknown"].includes(source.worktree_status)) fail(file, "代码来源需 repository、完整 commit（未知为 null）、worktree_status");
        if (!array(m.systems).includes(source.repository)) fail(file, `来源仓库未列入 systems：${source.repository}`);
        if (options.material) {
          const recorded = options.material.repositories.find((r) => r.name === source.repository);
          if (!recorded || source.commit !== (fullCommit.test(recorded.commit || "") ? recorded.commit : null) || source.worktree_status !== (recorded.worktreeStatus || "unknown")) fail(file, `来源仓库/commit/工作区状态与分析原料不一致：${source.repository}`);
        }
      } else if (source.kind === "document") {
        if (!text(source.document_id) || !relative(source.path) || !/^[0-9a-f]{64}$/.test(source.sha256 || "")) fail(file, "资料来源需 document_id、相对 path 和真实 sha256");
        if (options.material && !options.material.documents?.some((d) => d.document_id === source.document_id && d.path === source.path && d.sha256 === source.sha256)) fail(file, `资料来源与原料不一致：${source.document_id}`);
      } else fail(file, "sources.kind 必须为 code/document");
    }
    for (const system of array(m.systems)) if (!m.sources.some((s) => s?.kind === "code" && s.repository === system)) fail(file, `systems 缺少对应代码来源：${system}`);
    for (const [key, values] of Object.entries(asset.value)) {
      if (key === "meta" || !Array.isArray(values)) continue;
      for (const value of values) {
        if (!object(value)) { fail(file, `${key} 必须为对象列表`); continue; }
        if (["terms", "concepts", "capabilities", "rules", "flows", "claims"].includes(key)) {
          if (!text(value.id) || claims.has(value.id)) fail(file, `业务 ID 缺失或重复：${value.id}`);
          else claims.set(value.id, { ...value, file, meta: m, collection: key });
        }
        if (key === "nodes") {
          if (!text(value.id)) fail(file, "图谱 ID 必须为非空文本");
          if (nodes.has(value.id)) fail(file, `图谱 ID 重复：${value.id}`);
          nodes.set(value.id, value);
        }
      }
    }
  }
  // A real run always has every associated repository recorded, including multi-service context.
  for (const a of assets.filter((a) => object(a.meta))) {
    if (options.material) for (const repo of options.material.repositories) {
      if (!array(a.meta.sources).some((s) => s?.kind === "code" && s.repository === repo.name)) fail(a.file, `缺少本次多仓库来源：${repo.name}`);
    }
  }

  async function evidenceCheck(e, label, owner, requireCode = false) {
    if (!object(e)) { fail(label, "证据必须为结构化对象"); return; }
    if (!text(e.supports)) fail(label, "证据缺少 supports，需说明具体支持的结论");
    if (e.kind === "code") {
      const source = array(owner.meta?.sources).find((s) => s?.kind === "code" && s.repository === e.repository);
      if (!source || !fullCommit.test(e.commit || "") || source.commit !== e.commit) fail(label, "证据仓库或完整 commit 与资产来源不一致");
      if (!relative(e.path)) fail(label, `证据路径无效：${e.path}`);
      if (!text(e.symbol)) fail(label, "证据缺少 symbol");
      if (!Array.isArray(e.lines) || e.lines.length !== 2 || !e.lines.every((n) => Number.isInteger(n) && n > 0) || e.lines[0] > e.lines[1]) fail(label, "证据 lines 必须为有效的 [起始行,结束行]");
      if (e.node_id && !nodes.has(e.node_id)) fail(label, `证据引用不存在的节点：${e.node_id}`);
      if (e.node_id && nodes.get(e.node_id)?.path !== `${e.repository}/${e.path}`) fail(label, "证据路径与引用节点不一致");
      if (requireCode && (source?.worktree_status !== "clean" || options.currentRepositories?.find((r) => r.name === e.repository)?.matches === false)) fail(label, "VERIFIED 证据对应仓库必须在分析时与核验时均为 clean 且版本一致");
      if (options.readCode && relative(e.path) && fullCommit.test(e.commit || "")) {
        try {
          const body = await options.readCode(e.repository, e.commit, e.path);
          const count = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
          if (e.lines?.[1] > count) fail(label, `证据行号超出 ${e.path} 在对应 commit 中的 ${count} 行`);
        } catch { fail(label, `证据文件在对应 commit 中不存在或不可读取：${e.repository}/${e.path}`); }
      }
      impact.push({ repository: e.repository, commit: e.commit, path: e.path, symbol: e.symbol, knowledge_id: owner.meta?.knowledge_id, claim_id: owner.id, lifecycle: owner.lifecycle });
    } else if (e.kind === "document") {
      if (requireCode) fail(label, "业务资料不能单独证明代码已实现 VERIFIED 结论");
      if (!array(owner.meta?.sources).some((s) => s?.kind === "document" && s.document_id === e.document_id && s.sha256 === e.sha256 && s.path === e.path) || !text(e.locator)) fail(label, "资料证据缺少有效来源版本或 locator");
    } else fail(label, "证据 kind 必须为 code/document");
  }

  for (const claim of claims.values()) {
    const label = `${claim.file}#${claim.id}`;
    if (!["code_fact", "business_rule", "inference"].includes(claim.claim_type)) fail(label, "claim_type 必须为 code_fact/business_rule/inference");
    if (!["VERIFIED", "UNVERIFIED"].includes(claim.status)) fail(label, "status 必须为 VERIFIED/UNVERIFIED（仅表示代码核验）");
    if (claim.claim_type === "inference" && claim.status === "VERIFIED") fail(label, "推断 inference 不得标为 VERIFIED");
    if (!["current", "needs_review", "deprecated"].includes(claim.lifecycle)) fail(label, "缺少有效 lifecycle");
    if (claim.lifecycle !== "current" && claim.status === "VERIFIED") fail(label, "待复核/废弃结论不能继续作为当前 VERIFIED 事实");
    reviewErrors(claim, label, errors, Object.fromEntries(Object.entries(claim).filter(([k]) => !["file", "meta", "collection"].includes(k))));
    if (!object(claim.applicability) || !["conditions", "versions", "limitations"].every((k) => list(claim.applicability[k]))) fail(label, "applicability 需 conditions/versions/limitations 文本列表");
    if (claim.status === "VERIFIED" && !claim.applicability?.versions?.length) fail(label, "VERIFIED 结论需声明适用版本");
    if (!Array.isArray(claim.evidence)) fail(label, "缺少 evidence 列表");
    else {
      if (claim.status === "VERIFIED" && !claim.evidence.some((e) => e?.kind === "code")) fail(label, "VERIFIED 关键结论缺少代码证据");
      for (const e of claim.evidence) await evidenceCheck(e, label, claim, claim.status === "VERIFIED" && e?.kind === "code");
    }
    if (claim.status === "UNVERIFIED" && !claim.applicability?.limitations?.length) fail(label, "UNVERIFIED 结论需明确已知限制或待核实原因");
    if (claim.collection === "rules" && !["low", "medium", "high"].includes(claim.severity)) fail(label, "规则 severity 必须为 low/medium/high");
    if (claim.collection === "flows") {
      for (const k of ["trigger", "scope"]) if (!text(claim[k])) fail(label, `流程缺少 ${k}`);
      for (const k of ["preconditions", "steps", "data_changes", "async_events", "failures", "compensation"]) if (!list(claim[k]) || !claim[k].length) fail(label, `流程需 ${k} 文本列表；无适用项时明确说明`);
      const tests = claim.tests;
      if (!object(tests) || !["discovered", "read", "limitations"].every((k) => list(tests[k])) || !Array.isArray(tests.executions)) fail(label, "流程需分别记录测试 discovered/read/executions/limitations");
      else {
        if (!tests.executions.length && !tests.limitations.length) fail(label, "未运行测试时需说明测试覆盖限制");
        for (const r of tests.executions) if (!object(r) || !text(r.command) || !date(r.executed_at) || !Number.isInteger(r.exit_code) || !text(r.result)) fail(label, "测试执行记录需真实 command/executed_at/exit_code/result");
      }
    }
    for (const key of ["rules", "concepts", "related", "capabilities"]) {
      if (claim[key] !== undefined && !list(claim[key])) fail(label, `${key} 必须为 ID 列表`);
      for (const id of Array.isArray(claim[key]) ? claim[key] : []) {
        if (!claims.has(id) && !assets.some((a) => array(a.value.external_references).some((r) => object(r) && r.id === id && text(r.knowledge_id) && text(r.domain)))) fail(label, `悬空业务引用：${key} -> ${id}`);
      }
    }
  }
  for (const a of assets) {
    if (!object(a.meta)) continue;
    if (/\.md$/i.test(a.file)) {
      if (!list(a.meta.claim_refs) || !a.meta.claim_refs.length) fail(a.file, "业务 Markdown 需 claim_refs 引用权威条目；关键结论不得只写在自由正文中");
      for (const id of Array.isArray(a.meta.claim_refs) ? a.meta.claim_refs : []) if (!claims.has(id)) fail(a.file, `悬空 claim_refs：${id}`);
    }
    if (a.body) for (const token of a.body.match(/(?:CONCEPT|CAP|RULE|FLOW|CLAIM|TERM):[A-Za-z0-9:_-]+/g) || []) {
      if (!claims.has(token)) fail(a.file, `正文引用不存在的业务 ID：${token}`);
    }
    for (const n of Array.isArray(a.value.nodes) ? a.value.nodes : []) {
      if (!object(n)) { fail(a.file, "图谱节点必须为对象"); continue; }
      if (n.path) {
        if (!Array.isArray(n.evidence) || !n.evidence.length) fail(a.file, `代码节点缺少整理后的证据：${n.id}`);
        for (const e of array(n.evidence)) await evidenceCheck(e, `${a.file}#${n.id}`, { ...n, meta: a.meta }, true);
      }
    }
    for (const edge of Array.isArray(a.value.edges) ? a.value.edges : []) {
      if (!object(edge)) { fail(a.file, "图谱关系必须为对象"); continue; }
      if (!["VERIFIED", "UNVERIFIED"].includes(edge.status)) fail(a.file, "图谱关系需 status，未核实关系不应进入事实图谱");
      if (edge.status !== "VERIFIED" || !edge.evidence?.length) fail(a.file, "图谱关系必须有 VERIFIED 代码证据；未知关系放入未确认结论");
      for (const e of array(edge.evidence)) await evidenceCheck(e, a.file, { ...edge, meta: a.meta }, true);
    }
    for (const entry of array(a.value.entry_points)) {
      if (!object(entry) || !nodes.has(entry.node_id) || (entry.capability_id && !claims.has(entry.capability_id))) fail(a.file, "entry_points 引用了不存在的节点或能力");
    }
    for (const key of ["capability_mappings", "rule_mappings", "flow_mappings"]) for (const m of array(a.value[key])) {
      if (!object(m)) { fail(a.file, "映射必须为对象"); continue; }
      const id = m.capability_id || m.rule_id || m.flow_id;
      const claim = claims.get(id);
      if (!claim) fail(a.file, `映射引用不存在的业务 ID：${id}`);
      if (claim && claim.status !== "VERIFIED") warnings.push(`${a.file}：未核验结论的映射仅供定位，不代表代码已实现：${id}`);
      if (!Array.isArray(m.evidence_refs) || !m.evidence_refs.length) fail(a.file, `映射缺少 evidence_refs：${id}`);
      for (const ref of array(m.evidence_refs)) {
        if (!object(ref) || ref.claim_id !== id || !Number.isInteger(ref.index) || ref.index < 0 || !claim?.evidence?.[ref.index]) { fail(a.file, `悬空证据引用：${id}`); continue; }
        const e = claim.evidence[ref.index];
        if (e.kind !== "code" || !array(m.graph_nodes).some((nodeId) => nodes.get(nodeId)?.path === `${e.repository}/${e.path}`)) fail(a.file, `映射证据与代码节点没有对应路径：${id}`);
      }
      if (!list(m.graph_nodes) || !m.graph_nodes.length || m.graph_nodes.some((id) => !nodes.has(id))) fail(a.file, `映射引用无效图谱节点：${id}`);
    }
  }
  for (const c of claims.values()) if (c.collection === "flows" && c.status === "VERIFIED" && !assets.some((a) => array(a.value.flow_mappings).some((m) => m?.flow_id === c.id))) fail(c.file, `VERIFIED 流程缺少代码映射：${c.id}`);
  for (const node of nodes.values()) if (node.type === "Table" && !assets.some((a) => array(a.value.edges).some((e) => e?.rel === "belongs_to" && e.from === node.id) || array(a.value.capability_mappings).some((m) => array(m?.graph_nodes).includes(node.id)))) fail("graph", `核心表缺少业务域归属或能力映射：${node.id}`);
  // Central uniqueness is checked against the accessible current export, never historical runs.
  if (options.peerRoot) {
    let peers = [];
    try { peers = await fs.readdir(options.peerRoot, { withFileTypes: true }); } catch (e) { if (e.code !== "ENOENT") throw e; }
    for (const d of peers.filter((d) => d.isDirectory() && d.name !== options.run?.domainSlug)) {
      const peer = path.join(options.peerRoot, d.name);
      for (const f of await assetFiles(peer, ["domains", "graph", "mappings"])) {
        try {
          const other = parseAsset(f, await fs.readFile(path.join(peer, f), "utf8"));
          if (knowledgeIds.has(other.meta?.knowledge_id)) fail(f, `同中心 knowledge_id 重复：${other.meta.knowledge_id}（业务域 ${d.name}）`);
          for (const k of ["terms", "concepts", "capabilities", "rules", "flows", "claims"]) for (const item of array(other.value[k])) if (claims.has(item.id)) fail(f, `同中心业务 ID 重复：${item.id}（业务域 ${d.name}）`);
        } catch { warnings.push(`相邻域旧资产无法完整检查：${d.name}/${f}`); }
      }
    }
  }
  return { errors, warnings, assets: assets.map(({ file, meta }) => ({ file, ...meta })), impact };
}

export async function writeBusinessTemplates(draftsDir, domainName, context) {
  const domain = context.domain;
  const meta = (type) => metadataFor(context, type);
  const pending = (type = "code_fact") => ({ ...pendingClaim(type), applicability: { conditions: [], versions: [], limitations: ["尚未分析，需沿授权业务范围核实来源与适用条件"] } });
  const docs = {
    "overview": `# ${domainName} - 业务域概览\n\n## 业务边界与角色\n\n需补充\n\n## 能力与主要依赖\n\n使用稳定 ID 引用能力与流程，写明业务背景。\n\n## 核验与审核\n\nVERIFIED 仅表示代码证据核验，不表示业务审核；默认 pending。\n`,
    "flows": `# ${domainName} - 核心流程\n\n需补充\n\n详细流程维护在 flows.yaml，以 FLOW ID 引用；保留触发条件、业务对象与关键步骤摘要，规则通过 RULE ID 引用，不重复维护定义。\n`,
    "pitfalls": `# ${domainName} - 风险与已知限制\n\n需补充\n\n风险结论维护在 claims.yaml，按稳定 ID 引用并说明适用背景、影响与未核实环节。没有测试执行记录不等于已有局部源码事实无效。\n`,
  };
  const files = {};
  for (const [role, body] of Object.entries(docs)) files[`domains/${role}.md`] = markdown(meta(role), body,
    role === "overview" ? [`CAP:${domain}:main`] : role === "flows" ? [`FLOW:${domain}:main`] : [`CLAIM:${domain}:risk`]);
  const yaml = {
    "domains/glossary.yaml": { meta: meta("glossary"), terms: [{ id: `TERM:${domain}:main`, term: domainName, meaning: "需补充", ...pending("business_rule") }] },
    "domains/concepts.yaml": { meta: meta("concepts"), concepts: [{ id: `CONCEPT:${domain}`, name: domainName, type: "domain_entity", desc: "需补充", related: [], ...pending("business_rule") }] },
    "domains/capabilities.yaml": { meta: meta("capabilities"), capabilities: [{ id: `CAP:${domain}:main`, name: "核心能力", desc: "需补充", concepts: [`CONCEPT:${domain}`], rules: [], ...pending() }] },
    "domains/rules.yaml": { meta: meta("business_rules"), rules: [{ id: `RULE:${domain}:main`, name: "核心业务规则", subject: domainName, severity: "medium", desc: "需补充", checked_scope: "尚未核验", ...pending("business_rule") }] },
    "domains/flows.yaml": { meta: meta("flow_definitions"), flows: [{ id: `FLOW:${domain}:main`, name: "核心流程", trigger: "需补充", scope: "需补充", preconditions: [], steps: [], data_changes: [], async_events: [], failures: [], compensation: [], capabilities: [`CAP:${domain}:main`], rules: [], tests: { discovered: [], read: [], executions: [], limitations: ["未发现、阅读或运行测试，覆盖范围待核实"] }, ...pending() }] },
    "domains/claims.yaml": { meta: meta("claims"), claims: [{ id: `CLAIM:${domain}:risk`, name: "待核实风险", desc: "需补充", ...pending("inference") }] },
    [`graph/curated/${domain}.graph.yaml`]: { meta: { ...meta("code_graph"), verified_commits: Object.fromEntries(context.sources.filter((s) => s.kind === "code" && s.commit && s.worktree_status === "clean").map((s) => [s.repository, s.commit])) }, nodes: [{ id: `DOMAIN:${domain}`, type: "BusinessDomain", name: domainName, desc: "需补充业务域代码事实节点" }], edges: [] },
    [`mappings/${domain}.mapping.yaml`]: { meta: meta("code_mappings"), domain, capability_mappings: [], rule_mappings: [], flow_mappings: [], entry_points: [] },
  };
  for (const [file, value] of Object.entries(yaml)) files[file] = stringify(value);
  for (const [file, content] of Object.entries(files)) {
    try { await fs.writeFile(path.join(draftsDir, file), content, { flag: "wx" }); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
}
