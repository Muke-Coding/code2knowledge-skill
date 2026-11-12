import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { completeAssets } from "../test-support/complete-assets.mjs";
import { parseAsset, markdown, contentHash, assetFiles } from "../scripts/lib/contract.mjs";
const helper = fileURLToPath(new URL("../scripts/knowledge.mjs", import.meta.url));
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
async function fixture(t, { docsOnly = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c2k-contract-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repos = [];
  if (!docsOnly) for (const name of ["order-api", "order-core"]) {
    const dir = path.join(root, name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "refund.js"), "export function refund(amount) { if (amount <= 0) throw Error('amount'); return 'refunded'; }\n");
    git(dir, "init", "--quiet"); git(dir, "add", ".");
    git(dir, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", name);
    git(dir, "branch", "-M", "master"); git(dir, "clone", "--bare", dir, `${dir}-remote.git`); git(dir, "remote", "add", "origin", `${dir}-remote.git`);
    repos.push(dir);
  }
  const docs = path.join(root, "docs"); await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, "policy.md"), "# 金额规则\n退款金额必须为正数。\n");
  const workspace = path.join(root, ".code2knowledge"), output = path.join(root, "knowledge");
  let counter = 0;
  const invoke = (action, ...args) => {
    const r = spawnSync(process.execPath, [helper, action, "--workspace", workspace, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(r.error, undefined);
    return { code: r.status, data: r.stdout ? JSON.parse(r.stdout) : null, error: r.stderr };
  };
  const input = async (action, value) => {
    const file = path.join(root, `input-${counter++}.json`); await fs.writeFile(file, JSON.stringify(value));
    const r = invoke(action, "--input", file); assert.equal(r.code, 0, r.error); return r.data;
  };
  const run = await input("prepare", { productName: "订单中心", productSlug: "order-center", domainName: "退款", domainSlug: "refund", domainScope: "金额规则，不含支付系统", rawDocsDir: "", contextMode: "source-index", repoDirs: repos, rawDocsDir: docs, outputRootDir: output });
  const ids = docsOnly ? {} : await completeAssets(run);
  const mutate = async (file, fn) => {
    const full = path.join(run.draftsDir, file), value = parse(await fs.readFile(full, "utf8"));
    await fn(value); await fs.writeFile(full, stringify(value));
  };
  const validate = () => invoke("validate", "--run", run.runDir);
  const rejects = (result, pattern) => { assert.equal(result.code, 1, JSON.stringify(result)); assert.match(JSON.stringify(result.data?.validation?.errors || result.error), pattern); };
  return { root, repos, docs, workspace, output, run, ids, invoke, input, mutate, validate, rejects };
}

test("多仓库完整来源、pending 审核与可复查证据随五目录导出，未运行测试不否定局部源码事实", async (t) => {
  const { run, invoke } = await fixture(t);
  const result = invoke("export", "--run", run.runDir);
  assert.equal(result.code, 0, result.error);
  assert.equal(result.data.validation.impact.some((i) => i.repository === "order-core" && i.claim_id.startsWith("FLOW:")), true);
  assert.deepEqual((await fs.readdir(result.data.exportDir)).sort(), ["domains", "graph", "mappings", "ontology", "rules"]);
  for (const file of await assetFiles(result.data.exportDir, ["domains", "graph", "mappings"])) {
    const { meta } = parseAsset(file, await fs.readFile(path.join(result.data.exportDir, file), "utf8"));
    assert.equal(meta.review_status, "pending"); assert.equal(meta.owner, null);
    assert.deepEqual(meta.systems, ["order-api", "order-core"]);
    assert.equal(meta.sources.filter((s) => s.kind === "code").length, 2);
    for (const s of meta.sources.filter((s) => s.kind === "code")) {
      assert.equal(s.commit, git(run.repositories.find((r) => r.name === s.repository).path, "rev-parse", "HEAD"));
      assert.equal(s.worktree_status, "clean");
    }
  }
  const rules = parse(await fs.readFile(path.join(result.data.exportDir, "domains/rules.yaml"), "utf8"));
  for (const e of rules.rules[0].evidence) {
    const repo = run.repositories.find((r) => r.name === e.repository);
    assert.match(git(repo.path, "show", `${e.commit}:${e.path}`), /function refund/);
    assert.deepEqual(e.lines, [1, 1]); assert.equal(e.symbol, "refund"); assert.ok(e.supports);
  }
  await assert.rejects(fs.access(path.join(result.data.exportDir, "evidence")));
});

test("缺少 frontmatter/meta 不能认证为新契约，且不覆盖已有成果", async (t) => {
  const { run, invoke, mutate, rejects } = await fixture(t);
  const good = invoke("export", "--run", run.runDir); assert.equal(good.code, 0, good.error);
  const prior = await fs.readFile(path.join(good.data.exportDir, "domains/rules.yaml"), "utf8");
  await fs.writeFile(path.join(run.draftsDir, "domains/overview.md"), "# 旧资产\n真实描述，但没有来源元数据\n");
  await mutate("domains/rules.yaml", (v) => { delete v.meta; });
  rejects(invoke("export", "--run", run.runDir), /frontmatter|缺少 meta/);
  assert.equal(await fs.readFile(path.join(good.data.exportDir, "domains/rules.yaml"), "utf8"), prior);
});

test("VERIFIED 缺证据、缺符号、行号越界与来源版本伪造均被拒绝", async (t) => {
  const { mutate, validate, rejects, run } = await fixture(t);
  const original = await fs.readFile(path.join(run.draftsDir, "domains/rules.yaml"), "utf8");
  for (const [change, pattern] of [
    [(v) => { v.rules[0].evidence = []; }, /缺少代码证据/],
    [(v) => { delete v.rules[0].evidence[0].symbol; }, /symbol/],
    [(v) => { v.rules[0].evidence[0].lines = [1, 200]; }, /行号超出/],
    [(v) => { v.rules[0].evidence[0].lines = [2, 1]; }, /lines/],
    [(v) => { v.rules[0].evidence[0].commit = "a".repeat(40); }, /commit/],
    [(v) => { v.meta.sources[0].commit = "a".repeat(40); }, /分析原料不一致/],
    [(v) => { v.meta.sources = v.meta.sources.filter((s) => s.repository !== "order-api"); }, /缺少本次多仓库来源/],
    [(v) => { v.rules[0].evidence[0].path = "../refund.js"; }, /路径无效/],
  ]) {
    await fs.writeFile(path.join(run.draftsDir, "domains/rules.yaml"), original);
    await mutate("domains/rules.yaml", change); rejects(validate(), pattern);
  }
});

test("推断不能 VERIFIED，不能伪造人工确认，失效结论不能继续充当当前事实", async (t) => {
  const { run, mutate, validate, rejects } = await fixture(t);
  const file = "domains/rules.yaml", original = await fs.readFile(path.join(run.draftsDir, file), "utf8");
  for (const [change, pattern] of [
    [(v) => { v.rules[0].claim_type = "inference"; }, /inference 不得标为 VERIFIED/],
    [(v) => { v.rules[0].review_status = "confirmed"; }, /人工审核缺少真实依据/],
    [(v) => { v.rules[0].lifecycle = "deprecated"; }, /当前 VERIFIED/],
  ]) { await fs.writeFile(path.join(run.draftsDir, file), original); await mutate(file, change); rejects(validate(), pattern); }
});

test("有人工记录与内容指纹的确认可保留，内容或来源变化后必须重新审核", async (t) => {
  const { mutate, validate, rejects } = await fixture(t);
  await mutate("domains/rules.yaml", (v) => {
    const r = v.rules[0]; r.review_status = "confirmed";
    // Explicit fixture review data, never inferred from an Agent-produced conclusion.
    r.review = { reviewer: "人工审核测试记录", reviewed_at: new Date().toISOString(), basis: "用户提供的离线审核记录 fixture-1", content_sha256: contentHash(r) };
  });
  assert.equal(validate().code, 0);
  await mutate("domains/rules.yaml", (v) => { v.rules[0].desc = "金额可以为零"; });
  rejects(validate(), /内容指纹已变化/);
});

test("重复知识 ID、业务 ID、悬空规则与映射证据引用都有明确诊断", async (t) => {
  const { run, mutate, validate, rejects } = await fixture(t);
  const file = "domains/capabilities.yaml", original = await fs.readFile(path.join(run.draftsDir, file), "utf8");
  const overview = parseAsset("domains/overview.md", await fs.readFile(path.join(run.draftsDir, "domains/overview.md"), "utf8"));
  await mutate(file, (v) => { v.meta.knowledge_id = overview.meta.knowledge_id; }); rejects(validate(), /knowledge_id 重复/);
  await fs.writeFile(path.join(run.draftsDir, file), original);
  await mutate(file, (v) => { v.capabilities.push(structuredClone(v.capabilities[0])); }); rejects(validate(), /ID 缺失或重复|id 缺失或重复/);
  await fs.writeFile(path.join(run.draftsDir, file), original);
  await mutate(file, (v) => { v.capabilities[0].rules = ["RULE:refund:missing"]; }); rejects(validate(), /悬空业务引用/);
  await fs.writeFile(path.join(run.draftsDir, file), original);
  await mutate("mappings/refund.mapping.yaml", (v) => { v.rule_mappings[0].evidence_refs[0].index = 500; }); rejects(validate(), /悬空证据引用/);
});

test("资料规则可保留 UNVERIFIED，不强迫编造实现映射，资料版本变动阻止复用与导出", async (t) => {
  const { run, mutate, validate, rejects, docs, invoke } = await fixture(t);
  await mutate("domains/rules.yaml", (v) => {
    const source = v.meta.sources.find((s) => s.kind === "document");
    v.rules[0].status = "UNVERIFIED";
    v.rules[0].evidence = [{ ...source, locator: "金额规则", supports: "资料记载金额必须为正数，未证明实现" }];
    v.rules[0].applicability.limitations = ["仅业务资料规则，未核验代码实现"];
  });
  await mutate("mappings/refund.mapping.yaml", (v) => { v.rule_mappings = []; });
  assert.equal(validate().code, 0);
  await fs.appendFile(path.join(docs, "policy.md"), "规则已调整\n");
  assert.equal(invoke("check", "--material", run.materialDir).data.reusable, false);
  rejects(validate(), /业务资料已变化/);
  await fs.writeFile(path.join(docs, "policy.md"), "# 金额规则\n退款金额必须为正数。\n");
  assert.equal(invoke("check", "--material", run.materialDir).data.reusable, true);
  await fs.writeFile(path.join(docs, "new-policy.md"), "# 新规则\n新增人工审核条件\n");
  assert.equal(invoke("check", "--material", run.materialDir).data.reusable, false);
  rejects(validate(), /业务资料已变化/);
});

test("仅受影响来源的 VERIFIED 受 dirty 限制，其他仓库的局部事实仍可保留", async (t) => {
  const { run, repos, mutate, validate } = await fixture(t);
  for (const file of ["domains/glossary.yaml", "domains/concepts.yaml", "domains/capabilities.yaml", "domains/rules.yaml", "domains/flows.yaml"]) {
    await mutate(file, (v) => { for (const list of Object.values(v).filter(Array.isArray)) for (const c of list) c.evidence = c.evidence?.filter((e) => e.repository === "order-api"); });
  }
  await mutate("graph/curated/refund.graph.yaml", (v) => { v.nodes = v.nodes.filter((n) => n.service === "order-api"); });
  await mutate("mappings/refund.mapping.yaml", (v) => {
    for (const k of ["capability_mappings", "rule_mappings", "flow_mappings"]) for (const m of v[k]) { m.graph_nodes = ["FUNC:order-api:refund"]; m.evidence_refs = [m.evidence_refs[0]]; }
  });
  await fs.appendFile(path.join(repos[1], "refund.js"), "// unrelated uncommitted changes\n");
  const result = validate(); assert.equal(result.code, 0, JSON.stringify(result));
  assert.ok(result.data.validation.warnings.some((s) => s.includes("order-core")));
});

test("同中心跨域 ID 冲突被拒绝，移动文件和重新生成沿用既有 knowledge_id", async (t) => {
  const { run, invoke, input, validate, rejects } = await fixture(t);
  const exported = invoke("export", "--run", run.runDir); assert.equal(exported.code, 0, exported.error);
  const old = parseAsset("domains/overview.md", await fs.readFile(path.join(exported.data.exportDir, "domains/overview.md"), "utf8"));
  await fs.rename(path.join(exported.data.exportDir, "domains/overview.md"), path.join(exported.data.exportDir, "domains/business-overview.md"));
  const regenerated = await input("domain", { materialDir: run.materialDir, domainName: "退款", domainSlug: "refund", outputRootDir: path.dirname(path.dirname(path.dirname(exported.data.exportDir))) });
  const next = parseAsset("domains/overview.md", await fs.readFile(path.join(regenerated.draftsDir, "domains/overview.md"), "utf8"));
  assert.equal(next.meta.knowledge_id, old.meta.knowledge_id); assert.equal(next.meta.review_status, "pending");
  const neighbor = path.join(path.dirname(exported.data.exportDir), "neighbor");
  await fs.cp(exported.data.exportDir, neighbor, { recursive: true });
  rejects(validate(), /同中心 knowledge_id 重复|同中心业务 ID 重复/);
});

test("机器绝对路径、认证 URL 和内部 evidence 引用不能进入导出资产", async (t) => {
  const { run, validate, rejects } = await fixture(t);
  const file = path.join(run.draftsDir, "domains/overview.md"), original = await fs.readFile(file, "utf8");
  for (const [value, pattern] of [["/Users/example/private/source.js", /机器绝对路径/], ["https://user:secret@example.invalid/repo", /认证 URL/], ["evidence/order-api.yaml", /内部证据/]]) {
    await fs.writeFile(file, original + `\n${value}\n`); rejects(validate(), pattern);
  }
});

test("旧任务保持可读可续跑，缺元数据给出补齐诊断而不修改旧资产", async (t) => {
  const { run, invoke, input, validate, rejects } = await fixture(t);
  const manifest = path.join(run.runDir, "run.json"), old = JSON.parse(await fs.readFile(manifest, "utf8")); delete old.contractContext;
  await fs.writeFile(manifest, JSON.stringify(old));
  const file = path.join(run.draftsDir, "domains/overview.md"), legacy = "# 历史概览\n已有业务内容\n"; await fs.writeFile(file, legacy);
  assert.equal(invoke("status", "--run", run.runDir).code, 0);
  const wizard = await input("wizard", { intent: "resume", runDir: run.runDir });
  assert.equal(invoke("wizard-start", "--wizard", wizard.wizardId).code, 0);
  rejects(validate(), /补齐/); assert.equal(await fs.readFile(file, "utf8"), legacy);
});

test("导出不静默保留未纳入草稿的旧文件或删除历史成果", async (t) => {
  const { run, invoke } = await fixture(t);
  const first = invoke("export", "--run", run.runDir); assert.equal(first.code, 0, first.error);
  const extra = path.join(first.data.exportDir, "domains/retired.md"); await fs.writeFile(extra, "历史成果\n");
  const blocked = invoke("export", "--run", run.runDir);
  assert.equal(blocked.code, 1); assert.match(blocked.error, /旧资产/); assert.equal(await fs.readFile(extra, "utf8"), "历史成果\n");
});


test("只有业务资料也能交付，未知代码实现不被伪装为 VERIFIED", async (t) => {
  const { run, invoke } = await fixture(t, { docsOnly: true });
  await completeAssets(run);
  const result = invoke("export", "--run", run.runDir);
  assert.equal(result.code, 0, result.error);
  const doc = parse(await fs.readFile(path.join(result.data.exportDir, "domains/rules.yaml"), "utf8"));
  assert.deepEqual(doc.meta.systems, []);
  assert.equal(doc.meta.sources[0].kind, "document");
  assert.equal(doc.rules[0].status, "UNVERIFIED");
  assert.equal(doc.rules[0].review_status, "pending");
});

test("错误字段类型给出诊断，不以异常中断掩盖校验问题", async (t) => {
  const { run, mutate, validate, rejects } = await fixture(t);
  const file = "domains/rules.yaml", original = await fs.readFile(path.join(run.draftsDir, file), "utf8");
  for (const change of [
    (v) => { v.meta.systems = {}; },
    (v) => { v.meta.sources = "not-a-list"; },
    (v) => { v.rules[0].evidence = [null]; },
    (v) => { v.rules[0].applicability = null; },
    (v) => { v.meta.generated_at = 42; },
  ]) {
    await fs.writeFile(path.join(run.draftsDir, file), original); await mutate(file, change);
    const result = validate(); assert.equal(result.code, 1);
    assert.ok(result.data?.validation?.errors.length, JSON.stringify(result));
  }
});
