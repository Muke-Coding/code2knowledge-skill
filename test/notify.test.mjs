import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { notify, buildNotificationCard } from '../scripts/lib/notify.mjs';

test('通知默认关闭、签名正确、成功防重、失败可重试且记录不含凭证', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'c2k-notify-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, 'config.yml');
  const input = { workspace, event: 'intervention', task: 'refund', summary: 'master 拉取失败', details: ['请处理后继续'] };
  let calls = 0;
  const fetchImpl = async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.msg_type, 'interactive');
    assert.equal(body.card.header.template, 'orange');
    assert.equal(body.sign, crypto.createHmac('sha256', `${body.timestamp}\nsecret-value`).update('').digest('base64'));
    return { ok: true, json: async () => ({ code: 0 }) };
  };
  assert.equal((await notify(input, { configPath, fetchImpl })).status, 'skipped');
  assert.equal(calls, 0);
  await fs.writeFile(configPath, 'notification:\n  feishu:\n    enabled: true\n    webhook_url: https://open.feishu.cn/open-apis/bot/v2/hook/test-token\n    secret: secret-value\n');
  const sent = await notify(input, { configPath, fetchImpl });
  assert.equal(sent.status, 'sent');
  assert.equal((await notify(input, { configPath, fetchImpl })).duplicate, true);
  assert.equal(calls, 1);
  const other = { ...input, summary: '资料不可读取' };
  const failed = await notify(other, { configPath, fetchImpl: async () => { throw Error('test-token secret-value'); } });
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(await fs.readFile(failed.recordPath, 'utf8'), /test-token|secret-value/);
  assert.equal((await notify(other, { configPath, fetchImpl })).status, 'sent');
});

test('飞书业务错误不能当作成功，非官方 webhook 不发请求', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'c2k-notify-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const configPath = path.join(workspace, 'config.yml');
  const input = { workspace, event: 'completed', task: 'refund', summary: '完成' };
  await fs.writeFile(configPath, 'notification:\n  feishu:\n    enabled: true\n    webhook_url: https://open.feishu.cn/open-apis/bot/v2/hook/test\n');
  assert.equal((await notify(input, { configPath, fetchImpl: async () => ({ ok: true, json: async () => ({ code: 19024 }) }) })).status, 'failed');
  await fs.writeFile(configPath, 'notification:\n  feishu:\n    enabled: true\n    webhook_url: https://example.com/hook\n');
  assert.equal((await notify(input, { configPath, fetchImpl: () => { assert.fail('不应调用'); } })).status, 'failed');
});


test('测试环境禁止默认传输，子进程继承隔离且不读取真实配置', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../scripts/lib/notify.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { notify, buildNotificationCard } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await notify({ workspace: '/unused', event: 'completed', task: 'test', summary: 'test' }, { configPath: '/must-not-read' })));`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'test_or_disabled');
});


test('卡片按摘要、结果、位置与下一步分组，转义材料且测试标识醒目', () => {
  for (const event of ['intervention', 'completed']) {
    const card = buildNotificationCard({ event, task: '/local/run', summary: '<at id=all>测试</at> **伪标题**', details: ['输出位置：/local/path'], test: true });
    assert.equal(card.header.template, event === 'completed' ? 'green' : 'orange');
    assert.match(card.header.title.content, /【测试】/);
    assert.match(card.body.elements[0].content, /\*\*任务摘要\*\*/);
    assert.match(card.body.elements[0].content, /`\/local\/run`/);
    assert.match(card.body.elements[1].content, /&lt;at id=all&gt;/);
    assert.doesNotMatch(card.body.elements[1].content, /<at/);
    assert.ok(card.body.elements.some(e => e.content.includes('下一步')));
    assert.ok(card.body.elements.some(e => e.content.includes('`/local/path`')));
    assert.equal(card.schema, '2.0');
    assert.match(card.body.elements[0].content, /\n- 任务：/);
    assert.equal(card.body.elements[0].tag, 'markdown');
    assert.equal(card.body.elements.some(e => e.fields || e.tag === 'hr'), false);
  }
});
