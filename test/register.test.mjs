import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { register, supportedAgents } from "../scripts/register.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "c2k-register-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "中文 skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: code2knowledge\ndescription: test\n---\n");
  return { root, source };
}

test("所有 Agent 的项目入口可注册、重试且能定位完整 Skill", async (t) => {
  const { root, source } = await fixture(t);
  const projectDir = path.join(root, "业务项目");
  for (const agent of supportedAgents) {
    const options = { agent, scope: "project", source, projectDir };
    const result = await register(options);
    assert.deepEqual(await register(options), result);
    for (const file of result.files) {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) assert.equal(await fs.readFile(path.join(file, "SKILL.md"), "utf8"), await fs.readFile(path.join(source, "SKILL.md"), "utf8"));
      else assert.ok((await fs.readFile(file, "utf8")).includes(path.join(source, "SKILL.md")));
    }
  }
});

test("注册不覆盖已有 Skill 或自定义同名命令", async (t) => {
  const { root, source } = await fixture(t);
  const command = path.join(root, ".cursor/commands/code2knowledge.md");
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.writeFile(command, "my existing command");
  await assert.rejects(register({ agent: "cursor", source, userHome: root }), /未覆盖/);
  assert.equal(await fs.readFile(command, "utf8"), "my existing command");
  const skill = path.join(root, ".agents/skills/code2knowledge");
  await fs.mkdir(skill, { recursive: true });
  await assert.rejects(register({ agent: "codex", source, userHome: root }), /未覆盖/);
});

test("dry-run 不写文件，Copilot 限定项目范围", async (t) => {
  const { root, source } = await fixture(t);
  await register({ agent: "claude", source, userHome: root, dryRun: true });
  await assert.rejects(fs.access(path.join(root, ".claude")));
  await assert.rejects(register({ agent: "copilot", source, userHome: root }), /按项目注册/);
});
