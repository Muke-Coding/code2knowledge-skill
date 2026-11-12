import { syncBranches } from "./preflight.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  workspaceDir, listMaterials, readMaterial, readRun, inspectRepository,
  checkMaterial, buildKnowledgeBase, createCenterMaterial, inferBusinessSlug, assertBusinessSlug,
} from "./knowledge.mjs";

const wizardRoot = path.join(workspaceDir, "wizards");
const intents = new Set(["new", "reuse", "resume", "material"]);
const textFields = ["productName", "productSlug", "domainName", "domainSlug", "domainScope", "rawDocsDir", "outputRootDir", "contextMode", "branch"];
const byRecent = (a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
const isMissing = (value) => typeof value !== "string" || !value.trim();

async function directoryEntries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function listRuns() {
  const result = [];
  for (const entry of await directoryEntries(path.join(workspaceDir, "runs"))) {
    if (!entry.isDirectory()) continue;
    try { result.push(await readRun(path.join(workspaceDir, "runs", entry.name))); }
    catch { /* Incomplete/legacy directories must not prevent discovery. */ }
  }
  return result.sort(byRecent);
}

function wizardFile(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("向导编号无效");
  return path.join(wizardRoot, `${id}.json`);
}

export async function readWizard(id) {
  const wizard = JSON.parse(await fs.readFile(wizardFile(id), "utf8"));
  if (wizard.version !== 1 || wizard.wizardId !== id || !intents.has(wizard.intent)) throw new Error("向导记录无效");
  return wizard;
}

async function listWizards() {
  const result = [];
  for (const entry of await directoryEntries(wizardRoot)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const wizard = await readWizard(entry.name.slice(0, -5));
      if (wizard.status !== "started") result.push(wizard);
    } catch { /* Ignore incomplete checkpoint files. */ }
  }
  return result.sort(byRecent);
}

// Read local manifests only; no source extraction or whole-machine discovery.
export async function discoverWorkspace() {
  const [materials, runs, wizards] = await Promise.all([listMaterials(), listRuns(), listWizards()]);
  const products = new Map();
  for (const item of [...materials, ...runs]) {
    if (!products.has(item.productSlug)) products.set(item.productSlug, {
      productName: item.productName, productSlug: item.productSlug, domains: [],
    });
    const product = products.get(item.productSlug);
    if (item.domainName && !product.domains.includes(item.domainName)) product.domains.push(item.domainName);
  }
  let currentRepository = null;
  // Only consider the exact current directory; do not search parents or siblings for repositories.
  if ((await directoryEntries(process.cwd())).some((entry) => entry.name === ".git")) {
    try { currentRepository = await inspectRepository(process.cwd()); } catch { /* Optional candidate. */ }
  }
  const resumable = runs.filter((run) => run.status !== "exported");
  const menu = [];
  if (wizards.length || resumable.length) menu.push({ id: "resume", label: "继续上次任务", description: "保留已填信息和分析进度" });
  if (materials.length) menu.push({ id: "reuse", label: "复用共享原料，整理业务域", description: "沿用业务中心和仓库，不重复填写" });
  menu.push({ id: "new", label: "新建业务中心或共享原料", description: "使用当前仓库，或添加其他仓库" });
  const limit = 8;
  return {
    workspaceDir, projectDir: process.cwd(), currentRepository, menu,
    defaults: { outputRootDir: process.cwd(), rawDocsDir: "", contextMode: "repomix", branch: "master" },
    products: [...products.values()],
    materials: materials.slice(0, limit).map((item) => ({ materialId: item.materialId, materialDir: item.materialDir,
      productName: item.productName, productSlug: item.productSlug, createdAt: item.createdAt, repositories: item.repositories.map((repo) => repo.name), freshness: "unchecked" })),
    runs: resumable.slice(0, limit).map((run) => ({ runId: run.runId, runDir: run.runDir,
      productName: run.productName, productSlug: run.productSlug, domainName: run.domainName, domainSlug: run.domainSlug, domainScope: run.domainScope,
      status: run.status, updatedAt: run.updatedAt, materialDir: run.materialDir })),
    wizards: wizards.slice(0, limit).map((wizard) => ({ wizardId: wizard.wizardId, intent: wizard.intent,
      productName: wizard.answers.productName, domainName: wizard.answers.domainName,
      nextStep: wizard.nextStep, updatedAt: wizard.updatedAt })),
    totals: { materials: materials.length, runs: resumable.length, wizards: wizards.length },
  };
}

async function persist(wizard) {
  await fs.mkdir(wizardRoot, { recursive: true });
  const file = wizardFile(wizard.wizardId);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(wizard, null, 2) + "\n");
  await fs.rename(temporary, file);
  return { ...wizard, wizardPath: file };
}

// Save only choices the user actually made; missing answers are reported, never inferred.
export async function saveWizard(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("向导输入必须为对象");
  for (const key of Object.keys(input)) {
    if (!["wizardId", "intent", "answers", "materialDir", "runDir"].includes(key)) throw new Error(`未知向导参数：${key}`);
  }
  const previous = input.wizardId ? await readWizard(input.wizardId) : null;
  if (previous?.status === "started") throw new Error("向导已启动，请继续对应任务或新建向导");
  const intent = input.intent || previous?.intent;
  if (!intents.has(intent)) throw new Error("请选择 new / reuse / resume / material");
  const patch = input.answers || {};
  if (typeof patch !== "object" || Array.isArray(patch)) throw new Error("answers 必须为对象");
  for (const [key, value] of Object.entries(patch)) {
    if (!textFields.includes(key) && key !== "repoDirs" && key !== "branches") throw new Error(`未知向导字段：${key}`);
    if (key === "branches") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(branch => typeof branch !== "string" || !branch.trim())) throw new Error("branches 必须为仓库绝对路径到分支名的映射");
    } else if (key === "repoDirs") {
      if (!Array.isArray(value) || value.some((dir) => typeof dir !== "string" || !dir.trim())) throw new Error("repoDirs 必须为路径列表");
    } else if (typeof value !== "string") throw new Error(`${key} 必须为文本`);
  }
  const answers = { contextMode: "repomix", branch: "master", ...previous?.answers, ...patch };
  // A domain change is a new scope decision unless the same answer supplies its scope.
  if (previous?.answers.domainName && patch.domainName !== undefined &&
      patch.domainName !== previous.answers.domainName && patch.domainScope === undefined) delete answers.domainScope;
  for (const [nameField, slugField] of [["productName", "productSlug"], ["domainName", "domainSlug"]]) {
    if (patch[nameField] !== undefined && patch[nameField] !== previous?.answers[nameField] && patch[slugField] === undefined) delete answers[slugField];
    if (isMissing(answers[slugField])) {
      const inferred = inferBusinessSlug(answers[nameField]);
      if (inferred) answers[slugField] = inferred;
      else delete answers[slugField];
    }
    if (answers[slugField] !== undefined) assertBusinessSlug(answers[slugField], slugField);
  }
  if (!["source-index", "repomix"].includes(answers.contextMode)) throw new Error("contextMode 无效");
  // Discovery suggests a destination; only an explicit user answer selects it.
  if (!isMissing(answers.outputRootDir)) answers.outputRootDir = path.resolve(previous?.projectDir || process.cwd(), answers.outputRootDir);
  else delete answers.outputRootDir;
  if (answers.rawDocsDir) answers.rawDocsDir = path.resolve(previous?.projectDir || process.cwd(), answers.rawDocsDir);
  if (answers.branches) answers.branches = Object.fromEntries(Object.entries(answers.branches).map(([dir, branch]) => [path.resolve(previous?.projectDir || process.cwd(), dir), branch]));
  if (answers.repoDirs) answers.repoDirs = [...new Set(answers.repoDirs.map((dir) => path.resolve(previous?.projectDir || process.cwd(), dir)))];
  const materialDir = input.materialDir ?? previous?.materialDir;
  const runDir = input.runDir ?? previous?.runDir;
  if (intent === "reuse" && materialDir) {
    const material = await readMaterial(materialDir);
    Object.assign(answers, { productName: material.productName, productSlug: assertBusinessSlug(material.productSlug, "productSlug"), repoDirs: material.repositories.map((repo) => repo.path),
      branch: material.branch || "master", branches: material.branches || {}, rawDocsDir: material.rawDocsDir || "", contextMode: material.contextMode || "repomix" });
  }
  if (intent === "resume" && runDir) {
    const run = await readRun(runDir);
    Object.assign(answers, { productName: run.productName, productSlug: run.productSlug, domainName: run.domainName, domainSlug: run.domainSlug,
      domainScope: run.domainScope, outputRootDir: run.outputRootDir });
  }
  const missingFields = [];
  if (intent === "resume") { if (!runDir) missingFields.push("runDir"); }
  else {
    if (intent !== "reuse" && !Object.hasOwn(answers, "rawDocsDir")) missingFields.push("rawDocsDir");
    if (intent === "reuse" && !materialDir) missingFields.push("materialDir");
    if (intent !== "reuse" && isMissing(answers.productName)) missingFields.push("productName");
    if (isMissing(answers.productSlug)) missingFields.push("productSlug");
    if (intent !== "material" && isMissing(answers.domainName)) missingFields.push("domainName");
    if (intent !== "material" && isMissing(answers.domainSlug)) missingFields.push("domainSlug");
    if (intent !== "reuse" && !answers.repoDirs?.length && !answers.rawDocsDir) missingFields.push("repoDirs");
    if (intent !== "material" && isMissing(answers.domainScope)) missingFields.push("domainScope");
    if (intent !== "material" && isMissing(answers.outputRootDir)) missingFields.push("outputRootDir");
  }
  const wizard = {
    version: 1, wizardId: previous?.wizardId || crypto.randomUUID(), intent,
    status: missingFields.length ? "collecting" : "ready",
    projectDir: previous?.projectDir || process.cwd(), createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(), answers,
    ...(materialDir ? { materialDir } : {}), ...(runDir ? { runDir } : {}),
    ...(answers.outputRootDir && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(answers.productSlug || "") && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(answers.domainSlug || "") ? {
      exportDirPreview: path.join(answers.outputRootDir, "code-knowledge", answers.productSlug, answers.domainSlug),
    } : {}),
    missingFields, nextStep: missingFields[0] || "start",
  };
  return persist(wizard);
}

export async function startWizard(id) {
  const wizard = await readWizard(id);
  if (wizard.status === "started") {
    const result = wizard.intent === "material" ? await readMaterial(wizard.materialDir) : await readRun(wizard.runDir);
    const material = await readMaterial(result.materialDir);
    await syncBranches(material.repositories.map(repo => repo.path), { inspect: inspectRepository, workspace: workspaceDir, branch: material.branch, branches: material.branches });
    const freshness = await checkMaterial(result.materialDir);
    if (!freshness.reusable) throw new Error("原料已过期，请刷新后继续");
    return { wizard, result, alreadyStarted: true };
  }
  if (["new", "material"].includes(wizard.intent) && !Object.hasOwn(wizard.answers, "rawDocsDir")) throw new Error("请先选择是否添加文档资料（rawDocsDir）");
  if (wizard.status !== "ready") throw new Error(`向导尚未完成：${wizard.missingFields.join(", ")}`);
  let result;
  if (wizard.intent === "resume") {
    result = await readRun(wizard.runDir);
    const material = await readMaterial(result.materialDir);
    await syncBranches(material.repositories.map(repo => repo.path), { inspect: inspectRepository, workspace: workspaceDir, branch: material.branch, branches: material.branches });
    if (!(await checkMaterial(result.materialDir)).reusable) throw new Error("原料已过期，请刷新后继续");
  }
  else if (wizard.intent === "material") result = await createCenterMaterial(wizard.answers);
  else {
    if (wizard.intent === "reuse") {
      const check = await checkMaterial(wizard.materialDir);
      if (!check.reusable) throw new Error("共享原料版本已变化或工作区未核验，请选择刷新原料或其他原料；已填业务域信息已保留");
    }
    result = await buildKnowledgeBase({ ...wizard.answers, ...(wizard.intent === "reuse" ? { materialDir: wizard.materialDir } : {}) });
  }
  const updated = await persist({ ...wizard, status: "started", updatedAt: new Date().toISOString(),
    ...(result.runDir ? { runDir: result.runDir } : {}), ...(result.materialDir ? { materialDir: result.materialDir } : {}) });
  return { wizard: updated, result, alreadyStarted: false };
}
