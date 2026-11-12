import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../scripts/knowledge.mjs", import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "c2k-wizard-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "order-core");
  const workspace = path.join(root, ".code2knowledge");
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, "refund.js"), "export const refund = () => 'refunded';\n");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  git("branch", "-M", "master"); git("clone", "--bare", repo, path.join(root, "remote.git")); git("remote", "add", "origin", path.join(root, "remote.git"));
  const invoke = async (action, { input, wizard, ...rest } = {}) => {
    const args = [helper, action, "--workspace", workspace];
    if (input !== undefined) {
      const file = path.join(root, "answer.json");
      await fs.writeFile(file, JSON.stringify(input));
      args.push("--input", file);
    }
    if (wizard) args.push("--wizard", wizard);
    for (const [key, value] of Object.entries(rest)) args.push(`--${key}`, value);
    const result = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8" });
    if (result.error) throw result.error;
    return { code: result.status, data: result.stdout ? JSON.parse(result.stdout) : JSON.parse(result.stderr) };
  };
  const save = async (input) => {
    const result = await invoke("wizard", { input });
    assert.equal(result.code, 0, JSON.stringify(result.data));
    return result.data;
  };
  const complete = () => save({ intent: "new", answers: { productName: "订单中心", productSlug: "order-center", domainName: "退款", domainSlug: "refund", domainScope: "退款主流程", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo], outputRootDir: repo } });
  return { root, repo, workspace, invoke, save, complete };
}

test("空工作区发现无副作用，只给新建菜单和当前仓库候选", async (t) => {
  const { repo, workspace, invoke } = await fixture(t);
  const result = await invoke("discover");
  assert.equal(result.code, 0);
  assert.deepEqual(result.data.menu.map((item) => item.id), ["new"]);
  assert.equal(result.data.currentRepository.path, repo);
  assert.deepEqual(result.data.totals, { materials: 0, runs: 0, wizards: 0 });
  await assert.rejects(fs.access(workspace));
});

test("向导保存已选信息并报告缺项，重新读取后只需续填", async (t) => {
  const { repo, workspace, invoke, save } = await fixture(t);
  const first = await save({ intent: "new", answers: { productName: "订单中心", productSlug: "order-center" } });
  assert.equal(first.status, "collecting");
  assert.deepEqual(first.missingFields, ["rawDocsDir", "domainName", "domainSlug", "repoDirs", "domainScope", "outputRootDir"]);
  assert.equal(first.answers.outputRootDir, undefined);
  assert.equal(first.answers.rawDocsDir, undefined);
  await assert.rejects(fs.access(path.join(workspace, "runs")));
  const blocked = await invoke("wizard-start", { wizard: first.wizardId });
  assert.equal(blocked.code, 1);
  const second = await save({ wizardId: first.wizardId, answers: { domainName: "退款", domainSlug: "refund", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo] } });
  assert.deepEqual(second.missingFields, ["domainScope", "outputRootDir"]);
  assert.equal(second.answers.productName, "订单中心");
  const restored = await invoke("wizard", { wizard: first.wizardId });
  assert.equal(restored.data.answers.domainName, "退款");
  const discovered = await invoke("discover");
  assert.equal(discovered.data.wizards[0].wizardId, first.wizardId);
  assert.deepEqual(discovered.data.menu.map((item) => item.id), ["resume", "new"]);
  const ready = await save({ wizardId: first.wizardId, answers: { domainScope: "退款主流程与关键规则", outputRootDir: repo } });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.missingFields, []);
});

test("启动关联 run，重复启动同一向导不创建重复任务", async (t) => {
  const { workspace, invoke, complete } = await fixture(t);
  const wizard = await complete();
  const first = await invoke("wizard-start", { wizard: wizard.wizardId });
  assert.equal(first.code, 0, JSON.stringify(first.data));
  assert.equal(first.data.wizard.status, "started");
  const second = await invoke("wizard-start", { wizard: wizard.wizardId });
  assert.equal(second.code, 0);
  assert.equal(second.data.alreadyStarted, true);
  assert.equal(second.data.result.runDir, first.data.result.runDir);
  assert.equal((await fs.readdir(path.join(workspace, "runs"))).length, 1);
  const discovered = await invoke("discover");
  assert.equal(discovered.data.wizards.length, 0);
  assert.equal(discovered.data.runs[0].domainName, "退款");
  assert.deepEqual(discovered.data.menu.map((item) => item.id), ["resume", "reuse", "new"]);
  const edit = await invoke("wizard", { input: { wizardId: wizard.wizardId, answers: { domainName: "其他" } } });
  assert.equal(edit.code, 1);
});

test("复用原料带入中心与仓库，新业务域不重复提取原料", async (t) => {
  const { repo, workspace, invoke, save, complete } = await fixture(t);
  const initial = await complete();
  const first = (await invoke("wizard-start", { wizard: initial.wizardId })).data.result;
  const reuse = await save({ intent: "reuse", materialDir: first.materialDir, answers: { domainName: "履约", domainSlug: "fulfillment" } });
  assert.equal(reuse.answers.productName, "订单中心");
  assert.equal(reuse.answers.productSlug, "order-center");
  assert.deepEqual(reuse.answers.repoDirs, [repo]);
  assert.deepEqual(reuse.missingFields, ["domainScope", "outputRootDir"]);
  await save({ wizardId: reuse.wizardId, answers: { domainScope: "履约主流程", outputRootDir: repo } });
  const second = await invoke("wizard-start", { wizard: reuse.wizardId });
  assert.equal(second.code, 0, JSON.stringify(second.data));
  assert.equal(second.data.result.materialDir, first.materialDir);
  assert.notEqual(second.data.result.runDir, first.runDir);
  assert.equal((await fs.readdir(path.dirname(first.materialDir))).length, 1);
  assert.equal((await fs.readdir(path.join(workspace, "runs"))).length, 2);
});

test("过期原料阻止复用，改选刷新后保留已填域名与范围", async (t) => {
  const { repo, invoke, save, complete } = await fixture(t);
  const initial = await complete();
  const first = (await invoke("wizard-start", { wizard: initial.wizardId })).data.result;
  const reuse = await save({ intent: "reuse", materialDir: first.materialDir, answers: { domainName: "审核", domainSlug: "review", domainScope: "审核规则", outputRootDir: repo } });
  await fs.appendFile(path.join(repo, "refund.js"), "// changed\n");
  const rejected = await invoke("wizard-start", { wizard: reuse.wizardId });
  assert.equal(rejected.code, 1);
  const recorded = (await invoke("wizard", { wizard: reuse.wizardId })).data;
  assert.equal(recorded.status, "ready");
  assert.equal(recorded.answers.domainName, "审核");
  const refresh = await save({ wizardId: reuse.wizardId, intent: "new" });
  assert.deepEqual(refresh.answers.repoDirs, [repo]);
  assert.equal(refresh.answers.domainScope, "审核规则");
  const blockedRefresh = await invoke("wizard-start", { wizard: reuse.wizardId });
  assert.equal(blockedRefresh.code, 1);
  execFileSync("git", ["restore", "refund.js"], { cwd: repo });
  const started = await invoke("wizard-start", { wizard: reuse.wizardId });
  assert.equal(started.code, 0, JSON.stringify(started.data));
  assert.notEqual(started.data.result.materialDir, first.materialDir);
});

test("继续已有 run 不重建；已导出任务不再列为未完成", async (t) => {
  const { invoke, save, complete } = await fixture(t);
  const initial = await complete();
  const first = (await invoke("wizard-start", { wizard: initial.wizardId })).data.result;
  const resume = await save({ intent: "resume", runDir: first.runDir });
  assert.equal(resume.status, "ready");
  assert.equal(resume.answers.domainScope, "退款主流程");
  const continued = await invoke("wizard-start", { wizard: resume.wizardId });
  assert.equal(continued.data.result.runDir, first.runDir);
  const file = path.join(first.runDir, "run.json");
  const run = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...run, status: "exported" }));
  const discovery = await invoke("discover");
  assert.equal(discovery.data.runs.length, 0);
  assert.deepEqual(discovery.data.menu.map((item) => item.id), ["reuse", "new"]);
  assert.deepEqual(discovery.data.products[0].domains, ["退款"]);
  assert.equal((await invoke("runs")).data.runs.length, 1);
});

test("只准备原料不强制填写业务域；不同向导不覆盖彼此", async (t) => {
  const { repo, invoke, save } = await fixture(t);
  const material = await save({ intent: "material", answers: { productName: "订单中心", productSlug: "order-center", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo] } });
  assert.equal(material.status, "ready");
  const started = await invoke("wizard-start", { wizard: material.wizardId });
  assert.equal(started.code, 0, JSON.stringify(started.data));
  assert.ok(started.data.result.materialDir);
  assert.equal(started.data.result.runDir, undefined);
  const second = await save({ intent: "new", answers: { productName: "会员中心", productSlug: "member-center" } });
  assert.notEqual(second.wizardId, material.wizardId);
  const invalid = await invoke("wizard", { input: { wizardId: second.wizardId, answers: { repoDirs: "wrong" } } });
  assert.equal(invalid.code, 1);
  assert.equal((await invoke("wizard", { wizard: second.wizardId })).data.answers.productName, "会员中心");
  assert.equal((await invoke("wizard", { wizard: "../outside" })).code, 1);
});

test("改选业务域后重新收集范围，同一回答明确新范围时无需重复问", async (t) => {
  const { save, complete } = await fixture(t);
  const original = await complete();
  const changed = await save({ wizardId: original.wizardId, answers: { domainName: "履约", domainSlug: "fulfillment" } });
  assert.equal(changed.status, "collecting");
  assert.deepEqual(changed.missingFields, ["domainScope"]);
  assert.equal(changed.answers.productName, "订单中心");
  const explicit = await save({ wizardId: original.wizardId, answers: { domainName: "审核", domainSlug: "review", domainScope: "审核主流程" } });
  assert.equal(explicit.status, "ready");
  assert.equal(explicit.answers.domainScope, "审核主流程");
});

test("业务域名、边界和导出位置均显式收集，默认推荐不能提前启动", async (t) => {
  const { root, repo, save, invoke } = await fixture(t);
  const first = await save({ intent: "new", answers: { productName: "订单中心", productSlug: "order-center", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo] } });
  assert.deepEqual(first.missingFields, ["domainName", "domainSlug", "domainScope", "outputRootDir"]);
  const named = await save({ wizardId: first.wizardId, answers: { domainName: "退款", domainSlug: "refund" } });
  assert.deepEqual(named.missingFields, ["domainScope", "outputRootDir"]);
  const scoped = await save({ wizardId: first.wizardId, answers: { domainScope: "包含退款申请与审核；排除换货" } });
  assert.equal(scoped.nextStep, "outputRootDir");
  assert.equal(scoped.status, "collecting");
  assert.equal((await invoke("wizard-start", { wizard: first.wizardId })).code, 1);
  const ready = await save({ wizardId: first.wizardId, answers: { outputRootDir: "../知识库目录" } });
  assert.equal(ready.status, "ready");
  assert.equal(ready.exportDirPreview, path.join(root, "知识库目录", "code-knowledge", "order-center", "refund"));
  const started = await invoke("wizard-start", { wizard: first.wizardId });
  assert.equal(started.code, 0, JSON.stringify(started.data));
  assert.equal(started.data.result.exportDir, ready.exportDirPreview);
  assert.equal(started.data.result.domainScope, "包含退款申请与审核；排除换货");
  const savedRun = JSON.parse(await fs.readFile(path.join(started.data.result.runDir, "run.json"), "utf8"));
  assert.equal(savedRun.outputRootDir, path.join(root, "知识库目录"));
});

test("中文展示名需要英文标识，缺少时不能启动；确定后预览和实际目录一致", async (t) => {
  const { repo, save, invoke } = await fixture(t);
  const pending = await save({ intent: "new", answers: {
    productName: "订单中心", domainName: "退款", domainScope: "退款申请，不含换货", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo], outputRootDir: repo,
  } });
  assert.deepEqual(pending.missingFields, ["productSlug", "domainSlug"]);
  assert.equal(pending.exportDirPreview, undefined);
  assert.equal((await invoke("wizard-start", { wizard: pending.wizardId })).code, 1);
  const ready = await save({ wizardId: pending.wizardId, answers: { productSlug: "trade-center", domainSlug: "refund" } });
  assert.equal(ready.exportDirPreview, path.join(repo, "code-knowledge", "trade-center", "refund"));
  const started = await invoke("wizard-start", { wizard: ready.wizardId });
  assert.equal(started.code, 0, JSON.stringify(started.data));
  assert.equal(started.data.result.exportDir, ready.exportDirPreview);
  const reuse = await save({ intent: "reuse", materialDir: started.data.result.materialDir, answers: {
    domainName: "履约", domainSlug: "fulfillment", domainScope: "发货，不含退款", outputRootDir: repo,
  } });
  assert.equal(reuse.answers.productSlug, "trade-center");
  assert.equal(reuse.exportDirPreview, path.join(repo, "code-knowledge", "trade-center", "fulfillment"));
});

test("英文名称自动生成目录标识；改中文名称清空旧标识和范围", async (t) => {
  const { repo, save } = await fixture(t);
  const ready = await save({ intent: "new", answers: {
    productName: "Order Center", domainName: "Refund Flow", domainScope: "退款，不含换货", rawDocsDir: "", contextMode: "source-index", repoDirs: [repo], outputRootDir: repo,
  } });
  assert.equal(ready.status, "ready");
  assert.equal(ready.answers.productSlug, "order-center");
  assert.equal(ready.answers.domainSlug, "refund-flow");
  const changed = await save({ wizardId: ready.wizardId, answers: { productName: "会员中心", domainName: "积分" } });
  assert.deepEqual(changed.missingFields, ["productSlug", "domainSlug", "domainScope"]);
  assert.equal(changed.answers.productSlug, undefined);
  assert.equal(changed.answers.domainSlug, undefined);
  assert.equal(changed.exportDirPreview, undefined);
});

test("向导拒绝中文或越界目录标识，并保留之前的有效答案", async (t) => {
  const { complete, invoke } = await fixture(t);
  const ready = await complete();
  for (const answers of [{ productSlug: "订单中心" }, { domainSlug: "退款" }, { domainSlug: "../refund" }]) {
    const result = await invoke("wizard", { input: { wizardId: ready.wizardId, answers } });
    assert.equal(result.code, 1);
    assert.match(JSON.stringify(result.data), /目录标识/);
  }
  const saved = (await invoke("wizard", { wizard: ready.wizardId })).data;
  assert.equal(saved.answers.productSlug, "order-center");
  assert.equal(saved.answers.domainSlug, "refund");
});


test("新向导与发现推荐默认启用 Repomix，允许显式选择文件索引", async (t) => {
  const { invoke, save } = await fixture(t);
  const discovery = await invoke("discover");
  assert.equal(discovery.data.defaults.contextMode, "repomix");
  const wizard = await save({ intent: "new", answers: {} });
  assert.equal(wizard.answers.contextMode, "repomix");
  const updated = await save({ wizardId: wizard.wizardId, answers: { contextMode: "source-index" } });
  assert.equal(updated.answers.contextMode, "source-index");
  const restored = await invoke("wizard", { wizard: wizard.wizardId });
  assert.equal(restored.data.answers.contextMode, "source-index");
});
