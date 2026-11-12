#!/usr/bin/env node
// Internal Agent tool: users interact with the Skill rather than these commands.
import fs from "node:fs/promises";
import path from "node:path";

export async function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (!action || action === "--help") {
    console.log("Agent helper: notify --input FILE --workspace DIR; prepare|material|domain --input FILE [--workspace DIR]; discover|list|runs|wizard|wizard-start|check|status|validate|export --workspace DIR [--material DIR|--run DIR] [--output DIR]");
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!["--input", "--workspace", "--run", "--material", "--output", "--wizard"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`参数无效或缺值：${key}`);
    }
    options[key.slice(2)] = args[i + 1];
  }
  if (options.workspace) process.env.C2K_WORKSPACE = path.resolve(options.workspace);
  const kb = await import("./lib/knowledge.mjs");
  let input = {};
  if (options.input) input = JSON.parse(await fs.readFile(path.resolve(options.input), "utf8"));
  let wizard;
  if (["discover", "runs", "wizard", "wizard-start"].includes(action)) wizard = await import("./lib/wizard.mjs");
  let result;
  switch (action) {
    case "notify": {
      const { notify } = await import("./lib/notify.mjs");
      if (input.event !== "intervention") throw new Error("手动通知仅支持 intervention；完成通知由 export 生成");
      result = await notify({ ...input, workspace: kb.workspaceDir });
      break;
    }
    case "discover": result = await wizard.discoverWorkspace(); break;
    case "runs": result = { runs: await wizard.listRuns() }; break;
    case "wizard": result = options.input ? await wizard.saveWizard(input) : await wizard.readWizard(options.wizard); break;
    case "wizard-start": result = await wizard.startWizard(options.wizard); break;
    case "prepare": result = await kb.buildKnowledgeBase(input); break;
    case "material": result = await kb.createCenterMaterial(input); break;
    case "domain": result = await kb.createDomainFromMaterial(input); break;
    case "list": result = { workspaceDir: kb.workspaceDir, materials: await kb.listMaterials() }; break;
    case "check": result = await kb.checkMaterial(options.material); break;
    case "status": result = await kb.readRun(options.run); break;
    case "validate": result = await kb.validateRun(options.run); break;
    case "export": result = await kb.exportRun(options.run, options.output); break;
    default: throw new Error(`未知操作：${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.validation?.valid === false || result.reusable === false) process.exitCode = 1;
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
