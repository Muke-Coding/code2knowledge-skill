/** 共享内核兼容门禁；冻结1.0.2模板字节、固定来源、黄金资产报告及规范，使用合成数据且不调用模型。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeContext, writeBusinessTemplates, writeMaintenanceTemplates, validateContract, inspectContract, readAnalysisGuidelines, sha256, kernelCompatibility, assetFiles, parseAsset } from '../src/index.mjs';
/** 冻结旧版本生成结果；只更新新契约版本时经明确兼容决策修改，不随生成器自动刷新。 */
const baseline = JSON.parse(await readFile(new URL('./legacy-1.0.2.json', import.meta.url), 'utf8'));
/** @param action 使用空临时目录的异步测试 @returns 测试后删除所有合成文件；失败同样清理 */
async function isolated(action) {
  const root = await mkdtemp(join(tmpdir(), 'c2k-kernel-test-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('公开API生成的上下文和业务模板逐字节兼容Skill1.0.2', async () => {
  assert.deepEqual(makeContext(baseline.input), baseline.context);
  await isolated(async (root) => {
    await writeMaintenanceTemplates(root); await writeBusinessTemplates(root, '退款', makeContext(baseline.input));
    for (const [path, expected] of Object.entries(baseline.templates)) assert.equal(await readFile(join(root, path), 'utf8'), expected, path);
    await writeFile(join(root, 'domains/overview.md'), '已有业务修改'); await writeBusinessTemplates(root, '退款', makeContext(baseline.input));
    assert.equal(await readFile(join(root, 'domains/overview.md'), 'utf8'), '已有业务修改');
  });
});
test('黄金知识包报告及三份逆向规范保持兼容，版本独立', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/skill-2.0/', import.meta.url));
  // 冻结报告按JSON传输语义比较：旧实现的undefined可选属性在传输时本就被省略。
  assert.deepEqual(JSON.parse(JSON.stringify(await validateContract(fixture))), baseline.report);
  const names = ['analysis.md', 'knowledge-model.md', 'downstream-contract.md']; const values = await readAnalysisGuidelines();
  for (let i = 0; i < names.length; i++) assert.equal(sha256(values[i]), baseline.hashes[`references/${names[i]}`]);
  for (const [path, expected] of Object.entries(baseline.hashes)) assert.equal(sha256(await readFile(new URL('../' + path, import.meta.url))), expected, path);
  assert.deepEqual(kernelCompatibility, { kernelVersion: '0.1.0', contractVersion: '2.0', legacySkillVersion: '1.0.2' });
});
test('结构化诊断阻断非法资产，资料来源不冒充代码已实现', async () => {
  await isolated(async (root) => {
    await writeMaintenanceTemplates(root); await writeBusinessTemplates(root, '退款', makeContext({ ...baseline.input, repositories: [] }));
    await writeFile(join(root, 'domains/overview.md'), '# 缺少元数据');
    const report = await inspectContract(root);
    assert.ok(report.errors.length); assert.ok(report.diagnostics.some((item) => item.code === 'CONTRACT_INVALID' && item.severity === 'BLOCKING'));
    assert.equal(report.diagnostics.filter((item) => item.severity === 'BLOCKING').length, report.errors.length);
  });
});
test('只访问明确资产，拒绝符号链接且不覆盖既有维护资料', async () => {
  await isolated(async (root) => {
    await writeMaintenanceTemplates(root); await writeFile(join(root, 'ontology/node-types.yaml'), '本地维护');
    await writeMaintenanceTemplates(root); assert.equal(await readFile(join(root, 'ontology/node-types.yaml'), 'utf8'), '本地维护');
    await symlink(join(root, 'ontology'), join(root, 'domains/escape')); await assert.rejects(assetFiles(root), /符号链接/);
  });
});

test('解析接口保留未认证元数据，由契约校验负责拒绝错误格式', () => {
  assert.equal(parseAsset('domains/raw.yaml', 'foo: bar').meta, undefined);
  assert.equal(parseAsset('domains/raw.md', '---\nnull\n---\n正文').meta, null);
  assert.equal(parseAsset('domains/raw.md', '---\ntext\n---\n正文').meta, 'text');
});
