import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPrompt,
  createDomainFromMaterial,
  exportKnowledgeAssets,
  exportRun,
  normalizeRepoPaths,
  validateKnowledgeAssets,
  writeDraftTemplates,
} from "../scripts/lib/knowledge.mjs";

test("normalizeRepoPaths 支持数组、换行文本和旧 repoDir 参数", () => {
  assert.deepEqual(normalizeRepoPaths({ repoDirs: [" /a ", "/b", "/a"] }), ["/a", "/b"]);
  assert.deepEqual(normalizeRepoPaths({ repoDirs: "/a\n\n/b", repoDir: "/legacy" }), ["/a", "/b", "/legacy"]);
});

test("writeDraftTemplates 生成完整本体与质量规则", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code2knowledge-test-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await writeDraftTemplates(tempDir, "示例业务域", "sample-domain", { "service-core": "abc123" });

  const nodeTypes = await fs.readFile(path.join(tempDir, "ontology", "node-types.yaml"), "utf8");
  const relationTypes = await fs.readFile(path.join(tempDir, "ontology", "relation-types.yaml"), "utf8");
  const conceptTypes = await fs.readFile(path.join(tempDir, "ontology", "concept-types.yaml"), "utf8");
  const concepts = await fs.readFile(path.join(tempDir, "domains", "concepts.yaml"), "utf8");
  const graph = await fs.readFile(path.join(tempDir, "graph", "curated", "sample-domain.graph.yaml"), "utf8");
  const validation = await fs.readFile(path.join(tempDir, "rules", "validation-rules.yaml"), "utf8");
  const analysisPlan = await fs.readFile(path.join(tempDir, "analysis-plan.yaml"), "utf8");
  assert.match(nodeTypes, /Repository/);
  assert.match(nodeTypes, /BusinessDomain/);
  assert.match(nodeTypes, /required:/);
  assert.match(relationTypes, /rel: invokes/);
  assert.match(relationTypes, /from: \[ExternalSystem\]/);
  assert.match(relationTypes, /to: \[Controller\]/);
  assert.match(conceptTypes, /type: domain_entity/);
  assert.match(conceptTypes, /type: async_artifact/);
  assert.match(concepts, /type: domain_entity/);
  assert.match(concepts, /related: \[\]/);
  assert.match(graph, /verified_commits: \{\}/);
  assert.match(validation, /every_high_rule_has_code_mapping/);
  assert.match(analysisPlan, /status: pending/);
  assert.match(analysisPlan, /outside_scope_dependency_hops: 1/);
  const evidence = await fs.readFile(path.join(tempDir, "evidence", "service-core.yaml"), "utf8");
  assert.match(evidence, /service: "service-core"/);
  assert.match(evidence, /entry_points: \[\]/);
});

test("buildPrompt 将多个服务和可信 commit 写入生成约束", () => {
  const prompt = buildPrompt({
    productName: "示例中心",
    domainName: "示例业务域",
    domainScope: "示例业务边界",
    convertedDocsDir: "/tmp/docs",
    repoManifestPath: "/tmp/repomix/README.md",
    draftsDir: "/tmp/drafts",
    domainSlug: "sample-domain",
    repositories: [
      { name: "service-core", commit: "abc", contextPath: "/tmp/service-core.md" },
      { name: "service-api", commit: "def", contextPath: "/tmp/service-api.md" },
    ],
  });
  assert.match(prompt, /service-core（commit: abc）/);
  assert.match(prompt, /service-api（commit: def）/);
  assert.match(prompt, /产品\/开发\/测试/);
  assert.match(prompt, /每个 VERIFIED capability 至少映射一个代码节点/);
  assert.match(prompt, /domain_entity/);
  assert.match(prompt, /async_artifact/);
  assert.match(prompt, /不要用 BusinessDomain、Java 类名或代码节点类型代替业务概念类型/);
  assert.match(prompt, /invokes \/ calls/);
  assert.match(prompt, /范围优先、证据扩展/);
  assert.match(prompt, /入口→核心服务→数据读写\/跨服务调用→状态或结果→异常\/回滚/);
  assert.match(prompt, /不要从头到尾逐字阅读所有仓库原料/);
  assert.match(prompt, /两阶段执行/);
  assert.match(prompt, /第一阶段必须先读取上面列出的 repomix\/context 文件/);
  assert.match(prompt, /第二阶段允许读取与候选调用链直接相关的原始源码/);
  assert.match(prompt, /禁止从仓库根目录全量执行搜索/);
  assert.match(prompt, /每次扩展都要说明扩展原因/);
  assert.match(prompt, /repomix 与源码结论冲突时/);
  assert.match(prompt, /候选文件清单/);
  assert.match(prompt, /按已授权业务边界扩展/);
  assert.match(prompt, /无调用证据的模块列入排除项/);
  assert.match(prompt, /没有测试时声明覆盖限制/);
  assert.match(prompt, /分析计划.*analysis-plan.yaml/);
  assert.match(prompt, /服务级证据目录/);
  assert.match(prompt, /evidence\/\*\.yaml/);
  assert.match(prompt, /已有且 commit 未变化的服务证据可复用/);
});

test("低层导出同样拒绝尚未分析的骨架，不产生交付目录", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "code2knowledge-export-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const drafts = path.join(tempRoot, "drafts"), output = path.join(tempRoot, "output");
  await writeDraftTemplates(drafts, "示例业务域", "sample-domain");
  await assert.rejects(exportKnowledgeAssets(drafts, output), /校验失败/);
  await assert.rejects(fs.access(output));
});

test("同一中心原料可以生成多个业务域且不复制代码上下文", async (t) => {
  const materialDir = path.join(
    process.cwd(),
    ".code2knowledge",
    "materials",
    "test-center",
    `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const repomixDir = path.join(materialDir, "repomix");
  const convertedDocsDir = path.join(materialDir, "converted-docs");
  const contextPath = path.join(repomixDir, "service-core.md");
  const repoManifestPath = path.join(repomixDir, "README.md");
  const customOutputDir = await fs.mkdtemp("/tmp/code2knowledge-output-");
  t.after(() => fs.rm(materialDir, { recursive: true, force: true }));
  t.after(() => fs.rm(customOutputDir, { recursive: true, force: true }));

  await fs.mkdir(repomixDir, { recursive: true });
  await fs.mkdir(convertedDocsDir, { recursive: true });
  await fs.writeFile(contextPath, "shared source context");
  await fs.writeFile(repoManifestPath, "# repositories\n");
  await fs.writeFile(path.join(materialDir, "material.json"), JSON.stringify({
    version: 1,
    materialId: "test-material",
    productName: "测试中心",
    productSlug: "test-center",
    createdAt: "2026-08-12T00:00:00.000Z",
    convertedDocsDir,
    repoManifestPath,
    repositories: [await realRepository(t, contextPath)],
  }));

  const first = await createDomainFromMaterial({
    materialDir,
    domainName: "业务域一",
    domainSlug: "domain-one",
  });
  const second = await createDomainFromMaterial({
    materialDir,
    domainName: "业务域二",
    domainSlug: "domain-two",
    outputRootDir: customOutputDir,
  });

  assert.equal(first.materialDir, second.materialDir);
  assert.equal(first.repoManifestPath, second.repoManifestPath);
  assert.notEqual(first.runDir, second.runDir);
  t.after(() => fs.rm(first.runDir, { recursive: true, force: true }));
  t.after(() => fs.rm(second.runDir, { recursive: true, force: true }));
  assert.equal(await fs.readFile(contextPath, "utf8"), "shared source context");
  assert.match(await fs.readFile(first.promptPath, "utf8"), /业务域一/);
  assert.match(await fs.readFile(second.promptPath, "utf8"), /业务域二/);
  await assert.rejects(fs.access(path.join(first.runDir, "repomix")));
  await assert.rejects(fs.access(path.join(second.runDir, "repomix")));
  assert.equal(first.outputRootDir, process.cwd());
  assert.equal(second.outputRootDir, await fs.realpath(customOutputDir));

  const manifest = JSON.parse(await fs.readFile(first.runManifestPath, "utf8"));
  assert.equal(manifest.status, "draft_ready");
  assert.equal(first.runId, manifest.runId);
  assert.equal(first.runId, path.basename(first.runDir));
  assert.equal(manifest.outputRootDir, first.outputRootDir);
  assert.equal(manifest.lifecycle[0].type, "draft_ready");
  const runReadme = await fs.readFile(path.join(first.runDir, "README.md"), "utf8");
  assert.match(runReadme, /业务审核保持 pending/);
});

test("旧任务仍可读取，但旧格式产物不能直接认证为新契约", async (t) => {
  const materialDir = path.join(
    process.cwd(),
    ".code2knowledge",
    "materials",
    "export-center",
    `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const repomixDir = path.join(materialDir, "repomix");
  const convertedDocsDir = path.join(materialDir, "converted-docs");
  const contextPath = path.join(repomixDir, "service-core.md");
  const repoManifestPath = path.join(repomixDir, "README.md");
  const outputRootDir = await fs.mkdtemp("/tmp/code2knowledge-export-");
  t.after(() => fs.rm(materialDir, { recursive: true, force: true }));
  t.after(() => fs.rm(outputRootDir, { recursive: true, force: true }));

  await fs.mkdir(convertedDocsDir, { recursive: true });
  await fs.mkdir(repomixDir, { recursive: true });
  await fs.writeFile(contextPath, "shared source context");
  await fs.writeFile(repoManifestPath, "# repositories\n");
  await fs.writeFile(path.join(materialDir, "material.json"), JSON.stringify({
    version: 1,
    materialId: "export-material",
    productName: "导出中心",
    productSlug: "export-center",
    createdAt: "2026-08-12T00:00:00.000Z",
    convertedDocsDir,
    repoManifestPath,
    repositories: [await realRepository(t, contextPath)],
  }));

  const run = await createDomainFromMaterial({
    materialDir,
    domainName: "导出业务域",
    domainSlug: "export-domain",
  });
  t.after(() => fs.rm(run.runDir, { recursive: true, force: true }));

  const validation = await validateKnowledgeAssets(run.draftsDir);
  assert.equal(validation.valid, false);
  assert.equal(validation.domainSlugs[0], "export-domain");
  assert.ok(validation.errors.some((message) => message.includes("待补充")));

  // A legacy fixture with short commits and missing metadata must not be silently certified.
  await assert.rejects(exportRun(run.runDir, outputRootDir), /校验失败/);
  assert.equal((await fs.readdir(outputRootDir)).length, 0);
});

test("知识资产校验拒绝非法 YAML 和未定义的本体类型", async (t) => {
  const draftsDir = await fs.mkdtemp("/tmp/code2knowledge-validation-");
  t.after(() => fs.rm(draftsDir, { recursive: true, force: true }));
  await writeDraftTemplates(draftsDir, "校验业务域", "validation-domain");

  await fs.writeFile(
    path.join(draftsDir, "domains", "concepts.yaml"),
    "concepts:\n  - id: broken\n    name: 非法概念\n    type: unknown_type\n    desc: 已填写\n    related: []\n",
  );
  await fs.writeFile(path.join(draftsDir, "mappings", "validation-domain.mapping.yaml"), "domain: [invalid\n");

  const validation = await validateKnowledgeAssets(draftsDir);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("YAML 语法错误")));
  assert.ok(validation.errors.some((message) => message.includes("未定义的业务概念类型")));
});

async function realRepository(t, contextPath) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c2k-builder-git-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "service-core"); await fs.mkdir(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); await fs.writeFile(path.join(repo, "app.js"), "export const app = 1;\n"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  git("clone", "--bare", repo, path.join(root, "remote.git")); git("remote", "add", "origin", path.join(root, "remote.git"));
  return { name: "service-core", path: repo, commit: git("rev-parse", "HEAD"), worktreeStatus: "clean", contextPath };
}
