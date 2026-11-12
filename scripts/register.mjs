#!/usr/bin/env node
import { ensureConfig } from "./lib/config.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const supportedAgents = ["codex", "claude", "cursor", "gemini", "copilot"];
const marker = "code2knowledge-managed-entry-v1";

async function writeManaged(file, content, dryRun) {
  let previous;
  try { previous = await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous !== undefined && previous !== content && !previous.includes(marker)) {
    throw new Error(`已有同名入口，未覆盖：${file}`);
  }
  if (!dryRun) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return file;
}

async function linkSkill(target, source, dryRun) {
  try {
    const existing = await fs.realpath(target);
    if (existing !== await fs.realpath(source)) throw new Error(`已有同名 Skill，未覆盖：${target}`);
    return target;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Dangling symlinks are also existing entries; never replace them implicitly.
  try { await fs.lstat(target); throw new Error(`已有损坏入口，未覆盖：${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!dryRun) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  }
  return target;
}

export async function register({ agent, scope = "user", projectDir = process.cwd(), userHome = os.homedir(), source = skillDir, dryRun = false }) {
  if (!supportedAgents.includes(agent)) throw new Error(`不支持的 Agent：${agent}`);
  if (!["user", "project"].includes(scope)) throw new Error("scope 必须为 user 或 project");
  const root = scope === "user" ? userHome : path.resolve(projectDir);
  const instruction = `读取 ${JSON.stringify(path.join(source, "SKILL.md"))} 并遵循其完整流程。用户已启动 code2knowledge；先只读发现当前工作区的历史任务和共享原料，按 SKILL.md 用宿主提问工具呈现轻量选择向导；选择优先贯穿所有步骤：有可靠候选且有可用结构化提问工具时必须调用，推荐答案和自定义入口统一呈现，最后的导出位置也不能降级成文本编号；选择自定义后才补问缺失文本，工具原生自由输入不重复添加其他项。只有工具确实不可用或失败且无替代时才能用编号兜底并说明原因。中心和域的命名选项同时展示中文名称与英文目录标识，目录禁用中文；将业务域名、业务域边界说明和知识库导出位置作为明确引导项；新建原料确定仓库后必须通过结构化选择询问是否添加 PRD、ERD 等文档资料，选择添加后收集本地资料目录；默认空值不是用户已拒绝，启动前须完成选择。已有信息不重复问，复用沿用原资料，导出位置需用户选定。正式逆向前按 execution.md 检查全部依赖仓库，先选择分析分支（默认推荐 master，支持 main/其他分支及逐仓选择），按用户选定分支从 origin 快进同步；失败停止请求人工介入，不强制覆盖或清理改动。当前 Agent 直接执行分析，不要启动其他 Agent CLI。若用户已提供信息，沿用并只问缺失项。`;
  const files = [];
  let invocation = "/code2knowledge";
  if (agent === "codex" || agent === "claude") {
    const dir = agent === "codex" ? ".agents" : ".claude";
    files.push(await linkSkill(path.join(root, dir, "skills", "code2knowledge"), source, dryRun));
    if (agent === "codex") invocation = "$code2knowledge";
  } else if (agent === "cursor") {
    files.push(await writeManaged(path.join(root, ".cursor", "commands", "code2knowledge.md"),
      `<!-- ${marker} -->\n# Code2Knowledge\n\n${instruction}\n`, dryRun));
  } else if (agent === "gemini") {
    files.push(await writeManaged(path.join(root, ".gemini", "commands", "code2knowledge.toml"),
      `# ${marker}\ndescription = "启动代码业务知识库问答向导"\nprompt = ${JSON.stringify(instruction)}\n`, dryRun));
  } else {
    if (scope === "user") throw new Error("Copilot 入口按项目注册，请使用 --scope project --project <目录>");
    files.push(await writeManaged(path.join(root, ".github", "prompts", "code2knowledge.prompt.md"),
      `---\ndescription: "启动代码业务知识库问答向导"\nagent: "agent"\n---\n<!-- ${marker} -->\n${instruction}\n`, dryRun));
    files.push(await linkSkill(path.join(root, ".github", "skills", "code2knowledge"), source, dryRun));
  }
  const configPath = await ensureConfig({ userHome, dryRun });
  return { agent, scope, files, invocation, configPath, naturalLanguage: "code2knowledge", dryRun };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (["--agent", "--scope", "--project"].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith("--")) options[arg.slice(2)] = argv[++i];
    else if (arg === "--help") { console.log("code2knowledge --agent codex|claude|cursor|gemini|copilot|all [--scope user|project] [--project DIR] [--dry-run]"); return; }
    else throw new Error(`参数无效：${arg}`);
  }
  if (!options.agent) {
    if (!process.stdin.isTTY) throw new Error("非交互环境请指定 --agent codex|claude|cursor|gemini|copilot|all");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("选择 Agent：1 Codex（默认）  2 Claude Code  3 Cursor  4 Gemini CLI  5 Copilot  6 全部");
      const answer = (await rl.question("输入编号：")).trim() || "1";
      options.agent = [...supportedAgents, "all"][Number(answer) - 1];
      if (!options.agent) throw new Error("请选择 1 至 6");
      if (!options.scope) {
        const answer = (await rl.question("注册范围：1 当前用户（默认，Copilot 使用当前项目）  2 当前项目：")).trim() || "1";
        if (!["1", "2"].includes(answer)) throw new Error("请选择 1 或 2");
        options.scope = answer === "2" ? "project" : "user";
      }
    } finally { rl.close(); }
  }
  options.scope ||= "user";
  const agents = options.agent === "all" ? supportedAgents : [options.agent];
  const results = [];
  for (const agent of agents) {
    results.push(await register({ agent, scope: agent === "copilot" && options.agent === "all" ? "project" : options.scope,
      projectDir: options.project, dryRun: options.dryRun }));
  }
  console.log(JSON.stringify(results, null, 2));
  console.log("注册完成后重新打开 Agent。在 Codex 输入 $code2knowledge，其他 Agent 使用 /code2knowledge。Codex/Claude 也可输入 code2knowledge 自然触发；未匹配时使用原生入口。按提问回答即可。");
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
