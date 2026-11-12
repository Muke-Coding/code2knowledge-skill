import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import test from "node:test";
import { completeAssets } from "../test-support/complete-assets.mjs";

const helper = fileURLToPath(new URL("../scripts/knowledge.mjs", import.meta.url));
function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c2k-workflow-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "订单 core");
  const docs = path.join(root, "docs");
  await fs.mkdir(repo); await fs.mkdir(docs);
  await fs.writeFile(path.join(repo, "refund.js"), "export function refund(amount) { if (amount <= 0) throw Error('amount'); return 'refunded'; }\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  await fs.mkdir(path.join(repo, "ignored"));
  await fs.writeFile(path.join(repo, "ignored/secret.txt"), "not context");
  git(repo, "init", "--quiet");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  git(repo, "branch", "-M", "master"); git(repo, "clone", "--bare", repo, path.join(root, "remote.git")); git(repo, "remote", "add", "origin", path.join(root, "remote.git"));
  await fs.writeFile(path.join(docs, "business.md"), "# 退款\n仅支持正数退款金额。\n");
  const workspace = path.join(root, "work space");
  const output = path.join(root, "knowledge");
  const input = path.join(root, "request.json");
  await fs.writeFile(input, JSON.stringify({ productName: "产品: 中心", productSlug: "product-center", domainName: "退款: 流程", domainSlug: "refund-flow", domainScope: "正数退款", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo], rawDocsDir: docs, outputRootDir: output }));
  const invoke = (action, ...args) => {
    const result = spawnSync(process.execPath, [helper, action, "--workspace", workspace, ...args], { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const prepared = invoke("prepare", "--input", input);
  assert.equal(prepared.status, 0, prepared.stderr);
  return { root, repo, workspace, output, run: prepared.json, invoke };
}

const fill = completeAssets;

test("问答输入可离线准备、复用原料；骨架无法直接导出", async (t) => {
  const { run, repo, invoke } = await fixture(t);
  const context = await fs.readFile(run.repositories[0].contextPath, "utf8");
  assert.match(context, /source-index/);
  assert.match(context, /refund\.js/);
  assert.doesNotMatch(context, /secret\.txt/);
  assert.equal(await fs.readFile(path.join(run.convertedDocsDir, "business.md"), "utf8"), "# 退款\n仅支持正数退款金额。\n");
  assert.equal(invoke("check", "--material", run.materialDir).json.reusable, true);
  const validation = invoke("validate", "--run", run.runDir);
  assert.equal(validation.status, 1);
  assert.equal(validation.json.validation.valid, false);
  assert.equal(invoke("export", "--run", run.runDir).status, 1);
  await fs.appendFile(path.join(repo, "refund.js"), "// changed\n");
  assert.equal(invoke("check", "--material", run.materialDir).json.reusable, false);
});

test("有证据的产物可校验导出，导出排除内部产物并重新检查源码", async (t) => {
  const { run, repo, output, invoke } = await fixture(t);
  await fill(run, repo);
  const validation = invoke("validate", "--run", run.runDir);
  assert.equal(validation.status, 0, JSON.stringify(validation.json));
  const result = invoke("export", "--run", run.runDir);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.run.status, "exported");
  assert.equal(result.json.exportDir, path.join(output, "code-knowledge", "product-center", "refund-flow"));
  assert.equal(result.json.run.productName, "产品: 中心");
  assert.equal(result.json.run.domainName, "退款: 流程");
  assert.deepEqual(await fs.readdir(path.join(result.json.exportDir, "graph", "curated")), ["refund-flow.graph.yaml"]);
  assert.match(await fs.readFile(path.join(result.json.exportDir, "domains", "overview.md"), "utf8"), /退款/);
  assert.deepEqual((await fs.readdir(result.json.exportDir)).sort(), ["domains", "graph", "mappings", "ontology", "rules"]);
  await fs.appendFile(path.join(repo, "refund.js"), "// dirty\n");
  const dirty = invoke("validate", "--run", run.runDir);
  assert.equal(dirty.status, 1);
  assert.ok(dirty.json.validation.errors.some((error) => error.includes("VERIFIED")));
  assert.equal(invoke("export", "--run", run.runDir).status, 1);
});

test("源码路径越界、仓库版本变化和错误 YAML 结构得到可读诊断", async (t) => {
  const { run, repo, invoke } = await fixture(t);
  await fill(run, repo);
  const graphFile = path.join(run.draftsDir, "graph/curated", `${run.domainSlug}.graph.yaml`);
  const graphText = await fs.readFile(graphFile, "utf8");
  await fs.writeFile(graphFile, graphText.replace("/refund.js", "/../outside.js"));
  const invalidPath = invoke("validate", "--run", run.runDir);
  assert.equal(invalidPath.status, 1);
  assert.ok(invalidPath.json.validation.errors.some((error) => error.includes("路径无效")));
  await fs.writeFile(graphFile, graphText);
  await fs.writeFile(path.join(repo, "new.js"), "export const changed = true;\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "change");
  const drift = invoke("validate", "--run", run.runDir);
  assert.ok(drift.json.validation.errors.some((error) => error.includes("commit 已变化")));
  await fs.writeFile(path.join(run.draftsDir, "domains/concepts.yaml"), "concepts: not-an-array\n");
  const malformed = invoke("validate", "--run", run.runDir);
  assert.equal(malformed.status, 1);
  assert.ok(malformed.json.validation.errors.some((error) => error.includes("YAML 结构错误")));
});

test("默认在仓库内运行时，工具自身的未跟踪文件不使源码变脏", async (t) => {
  const { root, repo, invoke } = await fixture(t);
  const workspace = path.join(repo, ".code2knowledge");
  await fs.mkdir(workspace);
  const input = path.join(workspace, "request.json");
  await fs.writeFile(input, JSON.stringify({ productName: "中心", productSlug: "order-center", domainName: "退款", domainSlug: "refund", domainScope: "退款", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo], outputRootDir: repo }));
  const run = spawnSync(process.execPath, [helper, "prepare", "--input", input, "--workspace", workspace], { cwd: repo, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.repositories[0].worktreeStatus, "clean");
  const context = await fs.readFile(result.repositories[0].contextPath, "utf8");
  assert.doesNotMatch(context, /request\.json/);
  await fs.mkdir(path.join(repo, "code-knowledge"));
  await fs.writeFile(path.join(repo, "code-knowledge", "generated.md"), "generated output");
  const check = spawnSync(process.execPath, [helper, "check", "--material", result.materialDir, "--workspace", workspace], { cwd: repo, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  await fs.appendFile(path.join(repo, "refund.js"), "// real change\n");
  const dirty = spawnSync(process.execPath, [helper, "check", "--material", result.materialDir, "--workspace", workspace], { cwd: repo, encoding: "utf8" });
  assert.equal(dirty.status, 1);
  assert.equal(JSON.parse(dirty.stdout).reusable, false);
});

test("底层准备同样拒绝中文标识，在创建原料前报告问题", async (t) => {
  const { root, workspace, repo, invoke } = await fixture(t);
  const before = await fs.readdir(path.join(workspace, "materials", "product-center"));
  const input = path.join(root, "invalid.json");
  for (const names of [
    { productName: "中心", domainName: "Refund" },
    { productName: "Order Center", domainName: "退款" },
    { productName: "中心", productSlug: "中文", domainName: "Refund" },
    { productName: "Order Center", domainName: "退款", domainSlug: "退款" },
  ]) {
    await fs.writeFile(input, JSON.stringify({ ...names, rawDocsDir: "", contextMode: "source-index", repoDirs: [repo] }));
    const result = invoke("prepare", "--input", input);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /目录标识/);
  }
  assert.deepEqual(await fs.readdir(path.join(workspace, "materials", "product-center")), before);
  assert.deepEqual(await fs.readdir(path.join(workspace, "materials")), ["product-center"]);
});

test("旧中文标识任务可读取，但禁止导出中文目录且不自动改写旧数据", async (t) => {
  const { run, repo, output, invoke } = await fixture(t);
  await fill(run, repo);
  const file = path.join(run.runDir, "run.json");
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const identifiers of [{ productSlug: "订单中心" }, { domainSlug: "退款" }]) {
    const legacy = JSON.stringify({ ...original, ...identifiers });
    await fs.writeFile(file, legacy);
    assert.equal(invoke("status", "--run", run.runDir).status, 0);
    const result = invoke("export", "--run", run.runDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /英文标识新建任务/);
    assert.equal(await fs.readFile(file, "utf8"), legacy);
    await assert.rejects(fs.access(path.join(output, "code-knowledge")));
  }
});
