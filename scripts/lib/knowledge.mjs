import { requireDocumentChoice, syncMaster } from "./preflight.mjs";
import { notify } from "./notify.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { schemaVersion, fullCommit, sha256, makeContext, existingIdentities, writeBusinessTemplates, validateContract, assetFiles } from "./contract.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function canonicalPath(value) {
  let current = path.resolve(value);
  const missing = [];
  for (;;) {
    try { return path.join(fsSync.realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent;
    }
  }
}
const workspaceDir = canonicalPath(process.env.C2K_WORKSPACE || path.join(process.cwd(), ".code2knowledge"));
const projectContextTemplateDir = path.join(rootDir, "assets", "project-context");
const runRootDir = path.join(workspaceDir, "runs");
const materialRootDir = path.join(workspaceDir, "materials");
const knowledgeRootDir = process.cwd();
const documentExtensions = [".md", ".txt", ".csv", ".yaml", ".yml", ".json", ".docx", ".doc", ".pdf", ".xlsx", ".xls", ".pptx", ".ppt", ".html", ".htm"];
function emit(event, payload) {
  if (process.env.C2K_VERBOSE && (event === "log" || event === "task")) {
    console.error(payload.message || payload.step || payload.status);
  }
}

function slugify(value) {
  return String(value || "domain")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase().replace(/^\.+$/, "") || "domain";
}

// Business labels may be Chinese; directory identifiers are stable ASCII kebab-case.
function inferBusinessSlug(name) {
  if (typeof name !== "string" || /[^\x00-\x7f]/.test(name)) return "";
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function assertBusinessSlug(value, field) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${field} 必须为小写英文、数字及单连字符组成的目录标识（例如 order-center、refund）；中文仅用于展示名称。旧中文路径任务请保留原数据，以英文标识新建任务。`);
  }
  return value;
}

function resolveBusinessSlug(value, name, field) {
  return assertBusinessSlug(value ?? inferBusinessSlug(name), field);
}

// Access is governed by the host Agent; accept paths on Windows, Linux and macOS.
function assertInsideUserSpace(targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) throw new Error("路径不能为空");
  return canonicalPath(targetPath);
}

async function pathInfo(inputPath) {
  if (!inputPath) return { exists: false };
  const resolved = assertInsideUserSpace(inputPath);
  try {
    const stat = await fs.stat(resolved);
    return { path: resolved, exists: true, directory: stat.isDirectory(), file: stat.isFile() };
  } catch {
    return { path: resolved, exists: false };
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    emit("log", { level: "info", message: `$ ${command} ${args.join(" ")}` });
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: { ...process.env, ...options.env },
      shell: false,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      emit("log", { level: "stdout", message: text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      emit("log", { level: "stderr", message: text });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}

function runQuietCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: { ...process.env, ...options.env },
      shell: false,
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(options.raw ? output : output.trim());
      else reject(new Error(errorOutput.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function commandExists(command, args = ["--version"]) {
  try {
    await runCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir, extensions) {
  const result = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extensions.includes(path.extname(entry.name).toLowerCase())) result.push(full);
    }
  }
  await walk(dir);
  return result;
}

function normalizeRepoPaths(payload) {
  const rawPaths = Array.isArray(payload.repoDirs)
    ? [...payload.repoDirs]
    : String(payload.repoDirs || "").split(/\r?\n/);
  if (payload.repoDir) rawPaths.push(payload.repoDir);
  return [...new Set(rawPaths.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function inspectRepository(repoDir) {
  const resolved = assertInsideUserSpace(repoDir);
  const info = await pathInfo(resolved);
  if (!info.exists || !info.directory) throw new Error(`代码仓库目录不存在：${resolved}`);
  let commit = "UNVERIFIED";
  try {
    commit = await runQuietCommand("git", ["rev-parse", "HEAD"], { cwd: resolved });
  } catch {
    emit("log", { level: "info", message: `未读取到 Git commit，按 UNVERIFIED 记录：${resolved}` });
  }
  let worktreeStatus = "unknown";
  try {
    const rawStatus = await runQuietCommand("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: resolved, raw: true });
    const entries = rawStatus.split("\0").filter(Boolean);
    // Only omit our untracked output files. Tracked modifications always count.
    const generatedRoots = [workspaceDir, path.join(process.cwd(), "code-knowledge")];
    const relevant = entries.filter((entry) => {
      if (!entry.startsWith("?? ")) return true;
      const file = path.resolve(resolved, entry.slice(3));
      return !generatedRoots.some((dir) => file === dir || file.startsWith(dir + path.sep));
    });
    worktreeStatus = relevant.length ? "dirty" : "clean";
    const top = await runQuietCommand("git", ["rev-parse", "--show-toplevel"], { cwd: resolved });
    if (await fs.realpath(top) !== await fs.realpath(resolved)) throw new Error("not repository root");
  } catch { commit = "UNVERIFIED"; worktreeStatus = "unknown"; }
  return { name: path.basename(resolved), path: resolved, commit, worktreeStatus };
}

function buildPrompt({ productName, productSlug, contractContext, existingExportDir, domainName, domainScope, convertedDocsDir, repositories, repoManifestPath, draftsDir, domainSlug, analysisPlanPath, evidenceDir }) {
  const scopeText = domainScope || "未填写。请严格围绕本次业务域名称整理，遇到相邻业务域只记录依赖关系，不展开成主知识。";
  const repoLines = repositories.map((repo) => `- ${repo.name}（commit: ${repo.commit}）：${repo.contextPath}；工作区：${repo.worktreeStatus || "unknown"}`).join("\n") || "- 未提供代码仓库";
  const resolvedAnalysisPlanPath = analysisPlanPath || path.join(draftsDir, "analysis-plan.yaml");
  const resolvedEvidenceDir = evidenceDir || path.join(draftsDir, "evidence");
  return `你负责企业知识链路的知识生产层。请基于授权源码和业务资料，为「${productName}」的业务域「${domainName}」生成可长期维护、供产品/开发/测试共同使用的存量代码知识资产，供产品/开发/测试审核、在 Git 中管理，并由下游检索引用。
职责链路：源码与业务资料 → Code2Knowledge → Git 知识资产 → 文档站/RAG → MCP → 员工 Agent。
不承担 RAG、Embedding、MCP Server、员工权限或部署，不自动提交 Git、发布或修改被分析源码。导出不代表业务审核通过或员工可见。

材料目录（中心原料优先，源码按候选范围定向核验）：
- 非代码资料转换结果：${convertedDocsDir}
- 多仓库清单（仅用于服务名、commit 和上下文文件映射）：${repoManifestPath}
${repoLines}

原料使用边界（必须遵守）：
- 第一阶段必须先读取上面列出的 repomix/context 文件和多仓库清单，用它们定位当前业务域的入口、事件、Job、服务和候选文件；不能跳过中心原料直接扫描源码。若原料注明 source-index 模式，上下文只包含文件索引，应按索引定向读取当前源码并核对 commit 和工作区状态；索引不等于源码快照。
- 第二阶段允许读取与候选调用链直接相关的原始源码，用于核实方法实现、调用关系、SQL/事务、配置、异常处理和测试证据；每次扩展都要说明扩展原因。
- 禁止从仓库根目录全量执行搜索或逐字扫描无关模块；禁止为了补充背景读取与当前业务域无调用关系的源码、codegraph 索引或其他仓库内容。
- 原始源码只能沿入口到核心服务、跨服务调用、消息、数据读写和相关测试定向扩展，为完成已授权的主流程可沿证据扩展必要依赖，记录扩展原因；范围外依赖最多保留一跳摘要，无法访问的环节标为未验证，不编造完整链路。
- repomix 与源码结论冲突时，以本次材料记录的 commit 对应源码为准，并在产物中记录冲突；commit 不一致或无法核验时不得标记 VERIFIED。
- 代码路径只能引用 repomix 或定向源码中已有的仓库内相对路径；不能将本机绝对路径写入知识资产。

输出目录：
- ${draftsDir}
- 分析计划（先生成并持续更新）：${resolvedAnalysisPlanPath}
- 服务级证据目录（按服务保存结构化中间结果）：${resolvedEvidenceDir}

执行中间产物（用于控制范围、减少重复读取和支持断点重跑）：
- 先将候选入口、文件、依赖和排除范围写入 analysis-plan.yaml，再开始深读源码。
- 每个服务将分析结果写入 evidence/<service>.yaml；不要让多个分析任务直接同时修改最终知识文档。
- 汇总阶段优先读取 analysis-plan.yaml 和 evidence/*.yaml，仅对缺失证据定向补读源码。
- 已有且 commit 未变化的服务证据可复用；发现源码或范围变化时，只更新受影响的服务证据。

分析中间产物：
- 计划文件：${draftsDir}/analysis-plan.yaml
- 服务级证据目录：${draftsDir}/evidence/

通用导出目录结构：
- code-knowledge/<product>/<domain>/
- 本次产品或业务中心：${productName}
- 本次业务域：${domainName}
- 本次业务域边界：${scopeText}
- 已有导出目录（仅只读检查已有稳定 ID，不自动覆盖）：${existingExportDir || "未指定"}

默认产物采用“本体约束 ontology + 业务语义 domains + 代码事实 graph + 业务代码桥接 mappings”的四层结构：

1. domains/overview.md
   - 业务域做什么、解决什么问题、主要角色、模块关系

2. domains/flows.md
   - 核心流程，包含入口、前置条件、核心步骤、状态变化、失败/回滚场景

3. domains/pitfalls.md
   - 历史问题、已知风险、复杂调用链、SQL/事务/兼容风险

4. domains/glossary.yaml
   - 术语表

5. domains/concepts.yaml
   - 核心业务概念；type 必须使用 ontology/concept-types.yaml 定义的 11 类之一
   - domain_entity：有业务身份和生命周期的核心对象
   - relation_entity：可独立维护的对象间业务关系
   - state_entity：业务对象当前可判断、可迁移的状态
   - process_entity：由多个步骤组成的业务过程
   - process_state：异步流程、任务或审批的阶段状态
   - value_object：没有独立身份、由属性值定义的概念
   - business_identifier：稳定识别业务对象的编码或组合键
   - business_rule：被多个能力共享的规则性概念
   - async_artifact：消息、事件、任务记录或中转数据
   - config_entity：影响业务行为的开关、阈值、字典或配置
   - external_system：业务语义层依赖或同步的外部平台

6. domains/capabilities.yaml
   - 业务能力，每个能力至少关联概念、规则或代码入口

7. domains/rules.yaml
   - 业务规则，必须区分 VERIFIED / UNVERIFIED，重要结论标注来源

8. graph/curated/${domainSlug}.graph.yaml
   - 代码事实层，节点仅限 Service / Controller / ServiceClass / Repository / Mapper / Table / Entity / Convertor / Enum / FeignClient / MQTopic / Consumer / Job / Util / ExternalSystem / BusinessDomain
   - 边仅限 invokes / calls / feign_calls / reads / writes / references / converts / publishes / consumes / syncs_to / maps / belongs_to / triggers

9. mappings/${domainSlug}.mapping.yaml
   - 桥接层，把 capability/rule/flow 映射到代码节点，evidence_refs 引用权威条目的 evidence 数组索引，不重复维护证据

10. domains/flows.yaml 和 domains/claims.yaml
   - flows 为权威流程定义，flows.md 为可检索摘要；claims 仅存其他文件无法容纳的风险/独立结论，不复制已有规则和能力

知识契约 2.0（与生成骨架及 references/knowledge-model.md 一致）：
- 业务 Markdown 必须有 YAML frontmatter，业务 YAML 用顶层 meta；ontology 标识 type_constraint，维护资料标识 maintenance。
- 元数据最低含 schema_version/knowledge_id/product/domain/systems/knowledge_type/generated_at/review_status/owner/sources；跨系统 sources 必须逐仓保留完整 commit 和分析时工作区状态；未知 commit 为 null。owner 未知为 null。
- 本次可用的程序生成元数据上下文（不能编造时间或来源）：${JSON.stringify(contractContext || { product: productSlug, domain: domainSlug, sources: repositories.map((r) => ({ repository: r.name, commit: r.commit, worktree_status: r.worktreeStatus || "unknown" })) })}
- 已有 knowledge_id 和业务 ID 在移动/重新生成时保留；更新前只读检查已有导出资产，复用其稳定 ID，不复制旧审核结论。
- claim_type 区分 code_fact/business_rule/inference；status 仅为代码证据 VERIFIED/UNVERIFIED；inference 不得 VERIFIED；业务资料不能单独证明代码已实现。
- review_status 默认 pending，Agent 不得自动 confirmed/rejected、虚构审核人或 owner。只有用户提供真实审核记录时才可记录；审核需 reviewer/reviewed_at/basis/content_sha256，内容或来源变化须重新审核。
- 文档使用 claim_refs 引用规则/能力/流程/独立结论；逐条表达核验差异，不能用整篇 confidence 掩盖未核实项。每个可检索小节保留业务对象、条件、行为与 ID，不只写“按上述规则”。
- evidence 必须整理进最终业务条目或图谱，禁止只引用内部 EVIDENCE ID、evidence/ 路径、提示词或临时目录。最终资产不含机器绝对路径、凭证或认证仓库 URL。
- 每条结论声明 applicability.conditions/versions/limitations；UNVERIFIED 必须说明限制；needs_review/deprecated 不作为当前 VERIFIED。删项先检查引用并记录 Git 差异，不静默删除历史知识。
- 结构校验只证明程序检查项满足，不能证明调用语义、业务正确性、人工身份或测试真实通过。导出可包含 pending/UNVERIFIED，但必须清楚标记限制。

要求：
- 使用中文。
- 不要大段复制源码。
- 不要虚构业务规则，无法确认的标注“需确认”。
- 区分“代码事实”和“业务推断”。
- 先识别业务语义，再选择最具体的 concept type；不要用 BusinessDomain、Java 类名或代码节点类型代替业务概念类型。
- 每个 concept 必须包含 id、name、type、desc、related、status；related 只引用当前域已定义概念，跨域引用必须明确登记来源。
- 同一业务概念不要仅因分布在多个服务而重复创建；服务归属进入 graph，业务到代码的联系进入 mappings。
- 严格围绕本次业务域边界整理；相邻业务域只作为依赖、上下游或排除项说明。
- 采用“范围优先、证据扩展”的分析策略：先从业务域入口（Controller/API/Event/Job）、入口调用到 Service/Domain Service，再追踪 Feign/MQ、Repository/Mapper、Table/Entity 和外部系统；只有当调用链或规则需要时，才补读配置、SQL、转换器、枚举和测试。
- 分两阶段执行：阶段一只定向定位入口、事件、Job 及其直接调用，先产出候选文件清单；阶段二仅沿候选链路递归读取，按已授权业务边界扩展到必要跨服务依赖、读写表、异常/事务和相关测试。
- 必须先更新 analysis-plan.yaml，再按服务或证据类型生成 evidence/*.yaml；最终知识文档只能由主任务汇总 evidence 生成。
- 按服务分析；仅当用户授权且宿主支持时使用子任务。子任务只写各自 evidence，最终产物由主任务汇总。
- 子任务结果必须包含 service、entry_points、call_chains、data_access、events、rules、tests、unverified 和 evidence 字段；重复概念由主任务统一合并。
- 不要从头到尾逐字阅读所有仓库原料，也不要为了补充背景扫描与本业务域无调用关系的模块；优先使用多仓库清单和定向搜索定位文件，再读取命中的上下文。
- 每条主流程至少闭环到“入口→核心服务→数据读写/跨服务调用→状态或结果→异常/回滚”；完成主链路后执行一次遗漏检查，确认未漏掉 Feign、MQ、定时任务、事务和测试证据。
- 相邻模块只读取用于确认边界或依赖的最小上下文；无法证明与本域相关时，记录为排除项或需确认，不扩展为主知识。
- 流程需交代触发条件、前置状态、主要步骤、数据变化、异步事件、失败与补偿及适用范围。分别记录测试被发现、被阅读、实际执行及结果；没有测试时声明覆盖限制，不因此否认已有源码可证明的局部事实。无调用证据的模块列入排除项，范围外依赖最多保留 1 跳摘要。
- 已核验关键结论至少附 kind: code、repository、完整 commit、仓库相对 path、symbol、有效 lines、supports；方法名、注释、索引命中、单个调用点、未证实启用分支、配置默认值和未核实跨服务关系不足以证明业务事实。
- graph 中带 path 的节点必须是真实文件路径；不确定时不要写入事实层，改写入 UNVERIFIED 或 pitfalls。
- path 格式统一为 <仓库名>/<仓库内相对路径>，跨服务同名节点以仓库名消歧。
- meta.sources 逐仓保存真实完整 commit 与工作区状态；兼容字段 meta.verified_commits 只记录来源为 clean 且具有完整 commit 的仓库，未知不能声称已验证。
- 规则、能力、流程与关键结论采用统一 claim_type/status/review_status/evidence/applicability/lifecycle。规则的详细定义只维护于 domains/rules.yaml，其他文件通过稳定 ID 引用。
- MQ 的 publishes/consumes 应成对核查；外部系统使用 EXT: 前缀，MQ 使用 MQ: 前缀。
- mappings 必须让业务问题能一跳定位到代码节点。
- 每个 VERIFIED capability 至少映射一个代码节点，每条 VERIFIED high 规则必须有 rule_mapping；业务资料规则可以 UNVERIFIED 保留，不能伪造实现映射。
- 先定边界，再沿入口调用、跨服务 Feign、MQ、数据表、外部系统四条主线抽取，最后检查遗漏闭环。
- 面向产品写清业务口径，面向开发写清调用与数据事实，面向测试写清规则、状态迁移、异常和回归点。`;
}

const excludedDirs = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv", ".code2knowledge"]);
async function writeSourceIndex(repo, outputPath) {
  let files;
  if (repo.commit !== "UNVERIFIED") {
    files = (await runQuietCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo.path }))
      .split("\0").filter(Boolean);
  } else {
    files = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || excludedDirs.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) files.push(path.relative(repo.path, full).split(path.sep).join("/"));
      }
    }
    await walk(repo.path);
  }
  files = [...new Set(files)].filter((file) => {
    const full = path.resolve(repo.path, file);
    if ([workspaceDir, path.join(process.cwd(), "code-knowledge")].some((dir) => full === dir || full.startsWith(dir + path.sep))) return false;
    return !file.split("/").some((part) => excludedDirs.has(part));
  }).sort();
  await fs.writeFile(outputPath, `# ${repo.name} source-index\n\n模式：source-index（仅文件索引，不是源码快照）\n仓库：${repo.path}\ncommit：${repo.commit}\n工作区：${repo.worktreeStatus}\n\n按业务域从索引定位入口，定向读取源码；dirty/unknown 时不得把工作区当成该 commit 的已验证事实。\n\n## 文件清单\n${files.map((file) => JSON.stringify(file)).join("\n")}\n`);
}

async function checkMaterial(materialDir) {
  const material = await readMaterial(materialDir);
  const repositories = [];
  for (const recorded of material.repositories) {
    try {
      const current = await inspectRepository(recorded.path);
      const matches = current.commit !== "UNVERIFIED" && current.commit === recorded.commit &&
        current.worktreeStatus === "clean" && recorded.worktreeStatus === "clean";
      repositories.push({ name: recorded.name, recordedCommit: recorded.commit, currentCommit: current.commit,
        worktreeStatus: current.worktreeStatus, matches });
    } catch (error) { repositories.push({ name: recorded.name, matches: false, error: error.message }); }
  }
  const documents = [];
  for (const doc of material.documents || []) {
    let matches = false;
    try { matches = sha256(await fs.readFile(path.join(material.rawDocsDir, doc.path))) === doc.sha256; } catch { /* Missing source is stale. */ }
    documents.push({ document_id: doc.document_id, path: doc.path, matches });
  }
  if (material.rawDocsDir && Array.isArray(material.documents)) {
    try {
      for (const file of await collectFiles(material.rawDocsDir, documentExtensions)) {
        const relative = path.relative(material.rawDocsDir, file).split(path.sep).join("/");
        if (!material.documents.some((d) => d.path === relative)) documents.push({ path: relative, matches: false, reason: "新增资料" });
      }
    } catch { documents.push({ path: "资料目录", matches: false, reason: "不可读取" }); }
  }
  return { materialDir: material.materialDir, reusable: repositories.every((repo) => repo.matches) && documents.every((doc) => doc.matches), repositories, documents };
}

async function writeDraftTemplates(draftsDir, domainName, domainSlug, verifiedCommits = {}, options = {}) {
  await fs.mkdir(draftsDir, { recursive: true });
  const domainDir = path.join(draftsDir, "domains");
  await fs.cp(path.join(projectContextTemplateDir, "ontology"), path.join(draftsDir, "ontology"), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await fs.cp(path.join(projectContextTemplateDir, "rules"), path.join(draftsDir, "rules"), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await fs.mkdir(path.join(draftsDir, "graph", "curated"), { recursive: true });
  await fs.mkdir(path.join(draftsDir, "mappings"), { recursive: true });
  const evidenceDir = path.join(draftsDir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(domainDir, { recursive: true });

  const repositories = Array.isArray(options.repositories) ? options.repositories : [];
  const generatedAt = new Date().toISOString();
  const serviceNames = [...new Set([
    ...Object.keys(verifiedCommits || {}),
    ...repositories.map((repo) => String(repo.name || "").trim()).filter(Boolean),
  ])];
  const analysisPlan = `version: 1\nstatus: pending\ngenerated_at: ${JSON.stringify(generatedAt)}\ndomain: ${JSON.stringify(domainSlug)}\ndomain_name: ${JSON.stringify(domainName)}\nlimits:\n  outside_scope_dependency_hops: 1\n  authorized_main_flow: evidence_driven\n  source_scan: targeted_only\n  require_commit_match: true\nphases:\n  - id: plan\n    status: pending\n    output: analysis-plan.yaml\n  - id: evidence\n    status: pending\n    output: evidence/<service>.yaml\n  - id: synthesis\n    status: pending\n    output: domains/ and graph/ and mappings/\ncandidate_services:\n${serviceNames.map((name) => `  - ${JSON.stringify(name)}`).join("\n") || "  []"}\ncandidate_entries: []\ncandidate_files: []\ncross_service_dependencies: []\nexcluded_modules: []\nopen_questions: []\nevidence_files:\n${serviceNames.map((name) => `  - ${JSON.stringify(`evidence/${name}.yaml`)}`).join("\n") || "  []"}\nnotes: []\n`;
  const analysisPlanPath = path.join(draftsDir, "analysis-plan.yaml");
  if (!fsSync.existsSync(analysisPlanPath)) await fs.writeFile(analysisPlanPath, analysisPlan);
  for (const serviceName of serviceNames) {
    const evidencePath = path.join(evidenceDir, `${serviceName}.yaml`);
    if (fsSync.existsSync(evidencePath)) continue;
    const commit = verifiedCommits?.[serviceName] || repositories.find((repo) => repo.name === serviceName)?.commit || "UNVERIFIED";
    const contextPath = repositories.find((repo) => repo.name === serviceName)?.contextPath || "";
    await fs.writeFile(evidencePath, `version: 1\nstatus: pending\nservice: ${JSON.stringify(serviceName)}\ncommit: ${JSON.stringify(commit)}\ncontext_path: ${JSON.stringify(contextPath)}\nanalysis_plan: ../analysis-plan.yaml\nentry_points: []\ncall_chains: []\ndata_access: []\nevents: []\nrules: []\ntests: []\nunverified: []\nevidence: []\nexcluded: []\n`);
  }

  const context = options.contractContext || makeContext({ product: options.productSlug || "unassigned", domain: domainSlug,
    repositories: repositories.length ? repositories : Object.entries(verifiedCommits).map(([name, commit]) => ({ name, commit, worktreeStatus: "unknown" })) });
  await writeBusinessTemplates(draftsDir, domainName, context);
}

async function convertDocs(rawDocsDir, convertedDocsDir) {
  await fs.mkdir(convertedDocsDir, { recursive: true });
  const files = await collectFiles(rawDocsDir, [".docx", ".doc", ".pdf", ".xlsx", ".xls", ".pptx", ".ppt", ".html", ".htm"]);
  for (const file of await collectFiles(rawDocsDir, [".md", ".txt", ".csv", ".yaml", ".yml", ".json"])) {
    const out = path.join(convertedDocsDir, path.relative(rawDocsDir, file));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.copyFile(file, out);
  }
  if (files.length === 0) {
    emit("log", { level: "info", message: "未发现需要 MarkItDown 转换的非代码资料。" });
    return;
  }
  const hasMarkitdown = await commandExists("markitdown", ["--version"]);
  if (!hasMarkitdown) throw new Error("未找到 markitdown 命令，请先安装：pip install markitdown");
  for (const file of files) {
    const relative = path.relative(rawDocsDir, file);
    const out = path.join(convertedDocsDir, `${relative}.md`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const markdown = await runCommand("markitdown", [file]);
    await fs.writeFile(out, markdown);
    emit("log", { level: "info", message: `已转换：${file} -> ${out}` });
  }
}

async function runRepomix(repoDir, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand("npx", ["-y", "repomix", repoDir, "--output", outputPath], { cwd: repoDir });
}

async function exportKnowledgeAssets(draftsDir, exportDir) {
  const validation = await validateKnowledgeAssets(draftsDir);
  if (!validation.valid) throw new Error(`知识资产校验失败：${validation.errors.join("；")}`);
  const currentFiles = new Set(await assetFiles(draftsDir));
  for (const file of await assetFiles(exportDir)) {
    if (!currentFiles.has(file)) throw new Error(`导出目标仍有本次草稿未包含的旧资产：${file}；请明确保留并标记 deprecated，或授权处理旧文件后重试，工具不会静默删除`);
  }
  await fs.mkdir(exportDir, { recursive: true });
  const assetDirs = ["ontology", "domains", "graph", "mappings", "rules"];
  const copied = [];
  for (const dirName of assetDirs) {
    const source = path.join(draftsDir, dirName);
    if (!fsSync.existsSync(source)) continue;
    const target = path.join(exportDir, dirName);
    await fs.cp(source, target, { recursive: true, force: true });
    copied.push(dirName);
  }
  return {
    copied,
    skipped: ["AI_PROMPT.md", "analysis-plan.yaml", "evidence"],
  };
}

function assertRunDir(targetPath) {
  const resolved = assertInsideUserSpace(targetPath);
  const root = path.resolve(runRootDir);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`运行目录必须位于工作区 runs 下：${resolved}`);
  }
  return resolved;
}

async function readRun(runDir) {
  const resolved = assertRunDir(runDir);
  const manifestPath = path.join(resolved, "run.json");
  try {
    const run = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const draftsDir = path.resolve(String(run.draftsDir || ""));
    if (!run.runId || !run.productSlug || !run.domainSlug || !run.draftsDir) throw new Error("字段不完整");
    if ([run.productSlug, run.domainSlug].some((slug) => typeof slug !== "string" || slugify(slug) !== slug)) throw new Error("业务域标识无效");
    if (draftsDir !== path.join(resolved, "drafts")) throw new Error("草稿目录不属于当前任务");
    return { ...run, draftsDir, runDir: resolved, manifestPath };
  } catch {
    throw new Error(`无效的业务域任务，缺少或无法读取 run.json：${resolved}`);
  }
}

async function updateRun(runDir, changes, eventType) {
  const run = await readRun(runDir);
  const now = new Date().toISOString();
  const updated = {
    ...run,
    ...changes,
    updatedAt: now,
    lifecycle: [
      ...(Array.isArray(run.lifecycle) ? run.lifecycle : []),
      ...(eventType ? [{ type: eventType, at: now }] : []),
    ],
  };
  delete updated.runDir;
  delete updated.manifestPath;
  const manifestPath = path.join(runDir, "run.json");
  await fs.writeFile(manifestPath, JSON.stringify(updated, null, 2) + "\n");
  return { ...updated, runDir, manifestPath };
}

async function validateKnowledgeAssets(draftsDir, options = {}) {
  const resolved = assertInsideUserSpace(draftsDir);
  const required = [
    "ontology/node-types.yaml",
    "ontology/relation-types.yaml",
    "ontology/concept-types.yaml",
    "rules/validation-rules.yaml",
  ];
  const errors = [];
  const warnings = [];
  const yamlDocuments = new Map();
  let domainSlugs = [];
  try {
    domainSlugs = (await fs.readdir(path.join(resolved, "graph", "curated"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".graph.yaml"))
      .map((entry) => entry.name.slice(0, -".graph.yaml".length));
  } catch {
    errors.push("缺少 graph/curated 目录");
  }
  if (domainSlugs.length === 0 && errors.length === 0) errors.push("graph/curated 目录中没有业务域图谱");
  for (const domainSlug of domainSlugs) {
    required.push(
      `domains/overview.md`,
      `domains/flows.md`,
      `domains/pitfalls.md`,
      `domains/glossary.yaml`,
      `domains/concepts.yaml`,
      `domains/capabilities.yaml`,
      `domains/rules.yaml`,
      `domains/flows.yaml`,
      `domains/claims.yaml`,
      `graph/curated/${domainSlug}.graph.yaml`,
      `mappings/${domainSlug}.mapping.yaml`,
    );
  }
  for (const relativePath of required) {
    try {
      const content = await fs.readFile(path.join(resolved, relativePath), "utf8");
      if (!content.trim()) errors.push(`文件为空：${relativePath}`);
      else {
        if (/需补充|待补充/.test(content)) errors.push(`仍包含待补充内容：${relativePath}`);
        if (/\.ya?ml$/i.test(relativePath)) {
          try {
            yamlDocuments.set(relativePath, parseYaml(content));
          } catch (error) {
            errors.push(`YAML 语法错误：${relativePath}（${error.message.split("\n")[0]}）`);
          }
        }
      }
    } catch {
      errors.push(`缺少文件：${relativePath}`);
    }
  }

  const arrayKeys = {
    "ontology/node-types.yaml": ["node_types"],
    "ontology/relation-types.yaml": ["relation_types"],
    "ontology/concept-types.yaml": ["concept_types"],
    "rules/validation-rules.yaml": ["validation_rules"],
    "domains/concepts.yaml": ["concepts"],
    "domains/capabilities.yaml": ["capabilities"],
    "domains/rules.yaml": ["rules"],
    "domains/glossary.yaml": ["terms"],
  };
  for (const domain of domainSlugs) {
    arrayKeys[`graph/curated/${domain}.graph.yaml`] = ["nodes", "edges"];
    arrayKeys[`mappings/${domain}.mapping.yaml`] = ["capability_mappings", "rule_mappings", "entry_points"];
  }
  for (const [file, keys] of Object.entries(arrayKeys)) {
    if (!yamlDocuments.has(file)) continue;
    const doc = yamlDocuments.get(file);
    for (const key of keys) {
      if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc[key]) ||
          doc[key].some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        errors.push(`YAML 结构错误：${file}.${key} 必须为对象列表`);
      }
    }
  }
  if (errors.some((error) => error.startsWith("YAML 结构错误"))) {
    return { valid: false, checkedAt: new Date().toISOString(), draftsDir: resolved, domainSlugs,
      checkedFiles: required.length, errors, warnings };
  }

  const nodeDefinitions = yamlDocuments.get("ontology/node-types.yaml")?.node_types || [];
  const relationDefinitions = yamlDocuments.get("ontology/relation-types.yaml")?.relation_types || [];
  const conceptDefinitions = yamlDocuments.get("ontology/concept-types.yaml")?.concept_types || [];
  const nodeTypes = new Map(nodeDefinitions.map((item) => [item.type, item]));
  const relationTypes = new Map(relationDefinitions.map((item) => [item.rel, item]));
  const conceptTypes = new Set(conceptDefinitions.map((item) => item.type));

  for (const domainSlug of domainSlugs) {
    const concepts = yamlDocuments.get(`domains/concepts.yaml`)?.concepts || [];
    const capabilities = yamlDocuments.get(`domains/capabilities.yaml`)?.capabilities || [];
    const businessRules = yamlDocuments.get(`domains/rules.yaml`)?.rules || [];
    const graph = yamlDocuments.get(`graph/curated/${domainSlug}.graph.yaml`) || {};
    const mapping = yamlDocuments.get(`mappings/${domainSlug}.mapping.yaml`) || {};
    const conceptIds = new Set(concepts.map((item) => item.id).filter(Boolean));
    const capabilityIds = new Set(capabilities.map((item) => item.id).filter(Boolean));
    const nodeById = new Map();
    const ruleIds = new Set(businessRules.map((item) => item.id));
    for (const [kind, items] of [["concept", concepts], ["capability", capabilities], ["rule", businessRules]]) {
      const ids = new Set();
      for (const item of items) {
        if (!item.id || ids.has(item.id)) errors.push(`${kind} id 缺失或重复：${item.id || domainSlug}`);
        ids.add(item.id);
        if (!["VERIFIED", "UNVERIFIED"].includes(item.status)) errors.push(`${kind} status 必须为 VERIFIED 或 UNVERIFIED：${item.id}`);
      }
    }

    for (const concept of concepts) {
      if (!concept.id || !concept.name || !concept.type || !concept.desc) errors.push(`业务概念缺少必填字段：${domainSlug}`);
      if (concept.type && !conceptTypes.has(concept.type)) errors.push(`未定义的业务概念类型：${concept.type}`);
      for (const relatedId of Array.isArray(concept.related) ? concept.related : []) {
        if (!conceptIds.has(relatedId)) warnings.push(`跨域概念引用需由新契约检查登记来源：${relatedId}`);
      }
    }
    for (const capability of capabilities) {
      const linkedConcepts = Array.isArray(capability.concepts) ? capability.concepts : [];
      if (linkedConcepts.length === 0) errors.push(`业务能力未关联概念：${capability.id || domainSlug}`);
      for (const conceptId of linkedConcepts) {
        if (!conceptIds.has(conceptId)) errors.push(`业务能力引用不存在的概念：${capability.id || domainSlug} -> ${conceptId}`);
      }
    }
    for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!node.id || !node.type) {
        errors.push(`图谱节点缺少 id 或 type：${domainSlug}`);
        continue;
      }
      if (nodeById.has(node.id)) errors.push(`图谱节点 id 重复：${node.id}`);
      nodeById.set(node.id, node);
      const definition = nodeTypes.get(node.type);
      if (!definition) errors.push(`未定义的图谱节点类型：${node.type}`);
      for (const property of definition?.required || []) {
        if (node[property] === undefined || node[property] === null || node[property] === "") errors.push(`图谱节点缺少必填属性：${node.id}.${property}`);
      }
    }
    for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
      const definition = relationTypes.get(edge.rel);
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!definition) errors.push(`未定义的图谱关系：${edge.rel || "<empty>"}`);
      if (!fromNode) errors.push(`图谱关系起点不存在：${edge.from || "<empty>"}`);
      if (!toNode) errors.push(`图谱关系终点不存在：${edge.to || "<empty>"}`);
      if (definition && fromNode && !definition.from?.includes(fromNode.type)) errors.push(`图谱关系起点类型不匹配：${edge.rel} ${fromNode.type}`);
      if (definition && toNode && !definition.to?.includes(toNode.type)) errors.push(`图谱关系终点类型不匹配：${edge.rel} ${toNode.type}`);
    }

    const capabilityMappings = Array.isArray(mapping.capability_mappings) ? mapping.capability_mappings : [];
    const ruleMappings = Array.isArray(mapping.rule_mappings) ? mapping.rule_mappings : [];
    const mappedCapabilities = new Set();
    for (const item of capabilityMappings) {
      const capabilityId = item.capability_id || item.capability || item.id;
      if (capabilityId) mappedCapabilities.add(capabilityId);
      if (capabilityId && !capabilityIds.has(capabilityId)) errors.push(`映射引用不存在的业务能力：${capabilityId}`);
      const graphNodes = item.graph_nodes || item.nodes || item.code_nodes || [];
      if (!Array.isArray(graphNodes) || graphNodes.length === 0) errors.push(`业务能力映射缺少代码节点：${capabilityId || domainSlug}`);
      for (const nodeId of Array.isArray(graphNodes) ? graphNodes : []) {
        if (!nodeById.has(nodeId)) errors.push(`业务能力映射引用不存在的图谱节点：${nodeId}`);
      }
    }
    for (const capabilityId of capabilityIds) {
      if (capabilities.find((item) => item.id === capabilityId)?.status === "VERIFIED" && !mappedCapabilities.has(capabilityId)) errors.push(`业务能力缺少代码映射：${capabilityId}`);
    }
    const mappedRules = new Set(ruleMappings.map((item) => item.rule_id || item.rule || item.id).filter(Boolean));
    for (const rule of businessRules) {
      if (rule.status === "VERIFIED" && rule.severity === "high" && !mappedRules.has(rule.id)) errors.push(`高优先级规则缺少代码映射：${rule.id}`);
    }
    for (const item of ruleMappings) {
      const id = item.rule_id || item.rule || item.id;
      if (!ruleIds.has(id)) errors.push(`规则映射引用不存在的规则：${id}`);
      const nodes = item.graph_nodes || item.nodes || item.code_nodes || [];
      if (!Array.isArray(nodes) || nodes.length === 0) {
        errors.push(`规则映射缺少代码节点：${id}`);
        continue;
      }
      for (const nodeId of item.graph_nodes || item.nodes || item.code_nodes || []) {
        if (!nodeById.has(nodeId)) errors.push(`规则映射引用不存在的图谱节点：${nodeId}`);
      }
    }
  }
  const contract = await validateContract(resolved, options);
  errors.push(...contract.errors);
  warnings.push(...contract.warnings);
  return {
    valid: errors.length === 0,
    checkedAt: new Date().toISOString(),
    draftsDir: resolved,
    domainSlugs,
    checkedFiles: required.length,
    contractVersion: schemaVersion,
    assets: contract.assets,
    impact: contract.impact,
    errors,
    warnings,
  };
}

async function validateRunSources(run, outputRootDir = run.outputRootDir || knowledgeRootDir) {
  const material = await readMaterial(run.materialDir);
  const freshness = await checkMaterial(material.materialDir);
  const cache = new Map();
  const validation = await validateKnowledgeAssets(run.draftsDir, {
    run, material, currentRepositories: freshness.repositories,
    peerRoot: path.join(outputRootDir, "code-knowledge", run.productSlug),
    readCode: async (repository, commit, file) => {
      const repo = material.repositories.find((r) => r.name === repository);
      if (!repo || !fullCommit.test(commit) || commit !== repo.commit) throw new Error("来源版本不匹配");
      const key = `${repository}:${commit}:${file}`;
      if (!cache.has(key)) {
        const mode = await runQuietCommand("git", ["ls-tree", commit, "--", file], { cwd: repo.path });
        if (!/^100(?:644|755) blob /.test(mode)) throw new Error("不是版本内普通文件");
        cache.set(key, await runQuietCommand("git", ["show", `${commit}:${file}`], { cwd: repo.path, raw: true }));
      }
      return cache.get(key);
    },
  });
  validation.sourceCheck = freshness;
  if (!run.contractContext || !material.contextMode) validation.warnings.push("历史任务：保留读取和续跑；请依据真实原料补齐 2.0 元数据与证据后重新校验，不自动覆盖旧成果。");
  for (const repo of freshness.repositories.filter((r) => !r.matches)) {
    if (repo.currentCommit && repo.currentCommit !== repo.recordedCommit) validation.errors.push(`仓库 commit 已变化或不可读取，请生成新原料：${repo.name}`);
    else validation.warnings.push(`仓库工作区未核验：${repo.name}；引用该仓库的结论不能声明 VERIFIED`);
  }
  for (const doc of freshness.documents.filter((d) => !d.matches)) validation.errors.push(`业务资料已变化或不可读取，请刷新原料：${doc.path}`);
  // Verify graph paths independently of evidence so an otherwise valid claim cannot hide a bad node.
  for (const domain of validation.domainSlugs) {
    let graph;
    try { graph = parseYaml(await fs.readFile(path.join(run.draftsDir, "graph", "curated", `${domain}.graph.yaml`), "utf8")); } catch { continue; }
    for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
      if (!node?.path) continue;
      const parts = String(node.path).split("/");
      const repo = material.repositories.find((r) => r.name === parts[0]);
      if (!repo || parts.length < 2 || parts.includes("..") || String(node.path).includes("\\")) {
        validation.errors.push(`代码节点路径无效：${node.id} -> ${node.path}`); continue;
      }
      if (fullCommit.test(repo.commit || "")) {
        try { await runQuietCommand("git", ["cat-file", "-e", `${repo.commit}:${parts.slice(1).join("/")}`], { cwd: repo.path }); }
        catch { validation.errors.push(`代码节点路径在对应 commit 中不存在：${node.path}`); }
      }
    }
  }
  validation.valid = validation.errors.length === 0;
  return validation;
}

async function validateRun(runDir) {
  const run = await readRun(runDir);
  const validation = await validateRunSources(run);
  const updated = await updateRun(run.runDir, {
    status: validation.valid ? "validated" : "validation_failed",
    validation,
  }, validation.valid ? "validated" : "validation_failed");
  return { run: updated, validation };
}

async function exportRun(runDir, outputRootDir) {
  const run = await readRun(runDir);
  assertBusinessSlug(run.productSlug, "productSlug");
  assertBusinessSlug(run.domainSlug, "domainSlug");
  const resolvedOutputRoot = assertInsideUserSpace(outputRootDir || run.outputRootDir || knowledgeRootDir);
  const validation = await validateRunSources(run, resolvedOutputRoot);
  if (!validation.valid) throw new Error(`知识资产校验失败：${validation.errors.join("；")}`);
  const exportDir = path.join(resolvedOutputRoot, "code-knowledge", run.productSlug, run.domainSlug);
  const result = await exportKnowledgeAssets(run.draftsDir, exportDir);
  const exportedAt = new Date().toISOString();
  const updated = await updateRun(run.runDir, {
    status: "exported",
    outputRootDir: resolvedOutputRoot,
    exportDir,
    validation,
    lastExport: { exportedAt, exportDir, copied: result.copied },
  }, "exported");
  let notification;
  try {
    const files = await collectFiles(exportDir, [".md", ".yaml", ".yml", ".json"]);
    const fingerprint = sha256((await Promise.all(files.sort().map(async file => `${path.relative(exportDir, file)}:${sha256(await fs.readFile(file))}`))).join("\n"));
    notification = await notify({ workspace: workspaceDir, event: "completed", task: run.runDir,
      summary: `${run.productName} / ${run.domainName}：校验通过并已导出，业务仍待审核。`,
      details: [`本机输出位置（非在线链接）：${exportDir}`, `产物版本：${fingerprint}`, `校验提醒：${validation.warnings?.length || 0} 项；代码核验范围和测试限制请查看交付报告。`] });
  } catch { notification = { status: "failed", reason: "通知记录或发送失败；不影响已完成的导出" }; }
  return { run: updated, validation, outputRootDir: resolvedOutputRoot, exportDir, ...result, notification };
}

function assertMaterialDir(targetPath) {
  const resolved = assertInsideUserSpace(targetPath);
  const materialRoot = path.resolve(materialRootDir);
  if (resolved !== materialRoot && !resolved.startsWith(materialRoot + path.sep)) {
    throw new Error(`原料目录必须位于工作区 materials 下：${resolved}`);
  }
  return resolved;
}

async function readMaterial(materialDir) {
  const resolved = assertMaterialDir(materialDir);
  const manifestPath = path.join(resolved, "material.json");
  let material;
  try {
    material = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`无效的中心原料，缺少或无法读取 material.json：${resolved}`);
  }
  if (!material.productName || !material.productSlug || !Array.isArray(material.repositories)) {
    throw new Error(`中心原料清单字段不完整：${manifestPath}`);
  }
  if (typeof material.productSlug !== "string" || slugify(material.productSlug) !== material.productSlug) throw new Error("中心原料标识无效");
  for (const repo of material.repositories) {
    if (!repo || typeof repo.name !== "string" || !repo.name || repo.name.includes("/") || repo.name.includes("\\") ||
        [".", ".."].includes(repo.name) || typeof repo.path !== "string" || !path.isAbsolute(repo.path)) {
      throw new Error("中心原料仓库字段无效");
    }
  }
  const materialPaths = [
    material.convertedDocsDir,
    material.repoManifestPath,
    ...material.repositories.map((repo) => repo.contextPath),
  ];
  if (materialPaths.some((value) => {
    const resolvedPath = path.resolve(String(value || ""));
    return resolvedPath !== resolved && !resolvedPath.startsWith(resolved + path.sep);
  })) {
    throw new Error(`中心原料清单包含原料目录之外的上下文路径：${manifestPath}`);
  }
  return { ...material, materialDir: resolved, manifestPath };
}

async function listMaterials() {
  if (!fsSync.existsSync(materialRootDir)) return [];
  const productDirs = await fs.readdir(materialRootDir, { withFileTypes: true });
  const materials = [];
  for (const productEntry of productDirs) {
    if (!productEntry.isDirectory()) continue;
    const productDir = path.join(materialRootDir, productEntry.name);
    const entries = await fs.readdir(productDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        materials.push(await readMaterial(path.join(productDir, entry.name)));
      } catch {
        // Ignore incomplete material directories left by interrupted builds.
      }
    }
  }
  return materials.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createCenterMaterial(payload, taskId = crypto.randomUUID()) {
  emit("task", { taskId, taskType: "material", status: "running", step: "prepare-material" });
  const productName = String(payload.productName || payload.serviceName || "").trim();
  if (!productName) throw new Error("请填写产品或业务中心名称");
  const productSlug = resolveBusinessSlug(payload.productSlug ?? payload.serviceSlug, productName, "productSlug");
  const repoPaths = normalizeRepoPaths(payload);
  const rawDocsDir = payload.rawDocsDir ? assertInsideUserSpace(payload.rawDocsDir) : "";
  if (repoPaths.length === 0 && !rawDocsDir) throw new Error("请至少添加一个代码仓库或补充资料目录");

  requireDocumentChoice(payload);
  const preflight = await syncMaster(repoPaths, { inspect: inspectRepository, workspace: workspaceDir });
  const repositories = [];
  for (const repoPath of repoPaths) repositories.push(await inspectRepository(repoPath));
  const duplicateNames = repositories.filter((repo, index) => repositories.findIndex((item) => slugify(item.name) === slugify(repo.name)) !== index);
  if (duplicateNames.length) throw new Error(`仓库目录名重复，无法生成稳定服务标识：${[...new Set(duplicateNames.map((repo) => repo.name))].join(", ")}`);

  const contextMode = payload.contextMode || "repomix";
  if (!["source-index", "repomix"].includes(contextMode)) throw new Error("contextMode 必须为 source-index 或 repomix");
  const createdAt = new Date().toISOString();
  const materialId = `${createdAt.replace(/[:.]/g, "-")}-${productSlug}-${crypto.randomUUID().slice(0, 8)}`;
  const materialDir = path.join(materialRootDir, productSlug, materialId);
  const convertedDocsDir = path.join(materialDir, "converted-docs");
  const repomixDir = path.join(materialDir, "repomix");
  const repoManifestPath = path.join(repomixDir, "README.md");
  await fs.mkdir(materialDir, { recursive: true });

  if (rawDocsDir) {
    emit("task", { taskId, taskType: "material", status: "running", step: "convert-docs" });
    await convertDocs(rawDocsDir, convertedDocsDir);
  } else {
    await fs.mkdir(convertedDocsDir, { recursive: true });
  }

  await fs.mkdir(repomixDir, { recursive: true });
  for (const repo of repositories) {
    emit("task", { taskId, taskType: "material", status: "running", step: `${contextMode}:${repo.name}` });
    repo.contextPath = path.join(repomixDir, `${slugify(repo.name)}.md`);
    if (contextMode === "repomix") await runRepomix(repo.path, repo.contextPath);
    else await writeSourceIndex(repo, repo.contextPath);
  }
  await fs.writeFile(
    repoManifestPath,
    `# ${productName} 多仓库代码原料\n\n${repositories.map((repo) => `- ${repo.name}\n  - 路径：${repo.path}\n  - commit：${repo.commit}\n  - 上下文：${repo.contextPath}`).join("\n") || "未提供代码仓库。"}\n`,
  );

  const documents = [];
  if (rawDocsDir) for (const file of await collectFiles(rawDocsDir, documentExtensions)) {
    const relative = path.relative(rawDocsDir, file).split(path.sep).join("/");
    documents.push({ document_id: `DOC:${sha256(relative).slice(0, 24)}`, path: relative, sha256: sha256(await fs.readFile(file)) });
  }
  const material = {
    version: 1,
    preflight,
    documents,
    contextMode,
    materialId,
    productName,
    productSlug,
    createdAt,
    rawDocsDir,
    convertedDocsDir,
    repoManifestPath,
    repositories,
  };
  await fs.writeFile(path.join(materialDir, "material.json"), JSON.stringify(material, null, 2) + "\n");
  return { taskId, ...material, materialDir };
}

async function createDomainFromMaterial(payload, taskId = crypto.randomUUID()) {
  emit("task", { taskId, taskType: "domain", status: "running", step: "prepare-domain" });
  const material = await readMaterial(payload.materialDir);
  await syncMaster(material.repositories.map(repo => repo.path), { inspect: inspectRepository, workspace: workspaceDir });
  const freshness = await checkMaterial(material.materialDir);
  if (!freshness.reusable) throw new Error("原料已过期，请刷新原料后继续，保留历史证据");
  const productName = material.productName;
  const productSlug = assertBusinessSlug(material.productSlug, "productSlug");
  const domainName = String(payload.domainName || "").trim();
  if (!domainName) throw new Error("请填写业务域名称");
  const domainScope = String(payload.domainScope || "").trim();
  const domainSlug = resolveBusinessSlug(payload.domainSlug, domainName, "domainSlug");
  const configuredOutputRoot = payload.outputRootDir || knowledgeRootDir;
  const outputRootDir = assertInsideUserSpace(configuredOutputRoot);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${productSlug}-${domainSlug}-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = path.join(runRootDir, runId);
  const draftsDir = path.join(runDir, "drafts");
  const exportDir = path.join(outputRootDir, "code-knowledge", productSlug, domainSlug);
  await fs.mkdir(runDir, { recursive: true });

  emit("task", { taskId, taskType: "domain", status: "running", step: "drafts" });
  const verifiedCommits = Object.fromEntries(material.repositories.map((repo) => [repo.name, repo.commit]));
  const identities = await existingIdentities(exportDir);
  const contractContext = makeContext({ product: productSlug, domain: domainSlug, repositories: material.repositories,
    documents: material.documents || [], identities });
  await writeDraftTemplates(draftsDir, domainName, domainSlug, verifiedCommits, { repositories: material.repositories, contractContext });
  const promptPath = path.join(draftsDir, "AI_PROMPT.md");
  const analysisPlanPath = path.join(draftsDir, "analysis-plan.yaml");
  const evidenceDir = path.join(draftsDir, "evidence");
  await fs.writeFile(promptPath, buildPrompt({
    productName,
    productSlug,
    contractContext,
    existingExportDir: exportDir,
    domainName,
    domainScope,
    convertedDocsDir: material.convertedDocsDir,
    repositories: material.repositories,
    repoManifestPath: material.repoManifestPath,
    draftsDir,
    domainSlug,
    analysisPlanPath,
    evidenceDir,
  }));
  await fs.writeFile(
    path.join(runDir, "README.md"),
    `# ${productName} / ${domainName} 知识库构建任务\n\n- 产品或业务中心：${productName}\n- 业务域：${domainName}\n- 业务域边界：${domainScope || "未填写"}\n- 中心原料：${material.materialDir}\n- 原料生成时间：${material.createdAt}\n- 关联服务：${material.repositories.map((repo) => repo.name).join("、") || "无"}\n- 运行目录：${runDir}\n- 转换资料：${material.convertedDocsDir}\n- 多仓库清单：${material.repoManifestPath}\n- 草稿目录：${draftsDir}\n- AI 提示词：${promptPath}\n- 建议导出目录：${exportDir}\n\n下一步：使用 AI_PROMPT.md 补全知识资产，补全资产并通过程序校验后导出到选定本地位置；业务审核保持 pending，导出不等于审核或发布。\n`,
  );

  const createdAt = new Date().toISOString();
  const runManifest = {
    version: 1,
    runId,
    taskId,
    contractContext,
    status: "draft_ready",
    createdAt,
    updatedAt: createdAt,
    productName,
    productSlug,
    domainName,
    domainSlug,
    domainScope,
    materialDir: material.materialDir,
    materialId: material.materialId,
    draftsDir,
    promptPath,
    analysisPlanPath,
    evidenceDir,
    outputRootDir,
    exportDir,
    lifecycle: [{ type: "draft_ready", at: createdAt }],
  };
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(runManifest, null, 2) + "\n");

  return {
    runId,
    taskId,
    productName,
    productSlug,
    domainName,
    domainSlug,
    domainScope,
    contractContext,
    runDir,
    materialDir: material.materialDir,
    materialId: material.materialId,
    materialCreatedAt: material.createdAt,
    convertedDocsDir: material.convertedDocsDir,
    repoManifestPath: material.repoManifestPath,
    repositories: material.repositories,
    draftsDir,
    promptPath,
    analysisPlanPath,
    evidenceDir,
    exportDir,
    outputRootDir,
    runManifestPath: path.join(runDir, "run.json"),
  };
}

async function buildKnowledgeBase(payload, taskId = crypto.randomUUID()) {
  // Reject invalid domain identifiers before creating shared material.
  resolveBusinessSlug(payload.domainSlug, String(payload.domainName || ""), "domainSlug");
  const material = payload.materialDir
    ? await readMaterial(payload.materialDir)
    : await createCenterMaterial(payload, taskId);
  return createDomainFromMaterial({ ...payload, materialDir: material.materialDir }, taskId);
}

export {
  assertRunDir,
  workspaceDir,
  inspectRepository,
  checkMaterial,
  buildKnowledgeBase,
  buildPrompt,
  createCenterMaterial,
  createDomainFromMaterial,
  exportKnowledgeAssets,
  exportRun,
  listMaterials,
  normalizeRepoPaths,
  readMaterial,
  readRun,
  slugify,
  inferBusinessSlug,
  assertBusinessSlug,
  updateRun,
  validateKnowledgeAssets,
  validateRun,
  writeDraftTemplates,
};
