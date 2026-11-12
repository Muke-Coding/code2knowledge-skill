import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse } from 'yaml';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Escape caller content before placing it in trusted card markdown.
const escapeMarkdown = value => String(value).slice(0, 2400)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_\[\]~])/g, '\\$1').replace(/\r?\n/g, ' ');
const inlineCode = value => "`" + String(value).slice(0, 2400).replace(/`/g, 'ˋ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ') + "`";
export function buildNotificationCard({ event, task, summary, details = [], test = false }) {
  const completed = event === 'completed';
  const section = (title, lines) => ({ tag: 'markdown', content: `**${title}**\n${lines.map(line => `- ${line}`).join('\n')}`, text_align: 'left', text_size: 'normal_v2' });
  const labelLine = value => {
    const raw = String(value);
    const separator = raw.indexOf('：');
    if (separator < 0 || separator > 30) return escapeMarkdown(raw);
    const label = raw.slice(0, separator), content = raw.slice(separator + 1).trim();
    const isLocation = /路径|位置|记录|版本|服务|步骤/.test(label);
    return `${escapeMarkdown(label)}：${isLocation ? inlineCode(content) : escapeMarkdown(content)}`;
  };
  const locations = [], information = [];
  for (const line of details.slice(0, 8)) {
    (/^(本机输出位置|输出位置|报告路径|检查记录|产物版本)[：（]/.test(String(line)) ? locations : information).push(labelLine(line));
  }
  return {
    schema: '2.0',
    config: { update_multi: true, style: { text_size: { normal_v2: { default: 'normal', pc: 'normal', mobile: 'heading' } } } },
    header: { template: completed ? 'green' : 'orange', title: { tag: 'plain_text', content: `${test ? '【测试】' : ''}Code2Knowledge 任务通知` } },
    body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements: [
      section('任务摘要', [
        `任务：${inlineCode(task)}`,
        `状态：${completed ? '已导出 ✅ · 业务待审核' : '已暂停 ⏸ · 等待人工处理'}`,
        ...(test ? ['用途：样式测试，非真实任务'] : []),
      ]),
      section(completed ? '任务结果' : '阻塞说明', [escapeMarkdown(summary), ...information]),
      ...(locations.length ? [section(completed ? '交付位置' : '排查记录', locations)] : []),
      section('下一步', [completed ? '查看交付物，复核业务口径和未核验项；导出不代表业务审核通过。' : '处理上述阻塞后，回到 Agent 会话回复“继续”，系统将重新检查前置条件。']),
      { tag: 'markdown', content: '本机路径仅供定位，不是在线访问链接。', text_size: 'notation' },
    ] },
  };
}

export async function notify({ workspace, event, task, summary, details = [], test = false }, { configPath = path.join(os.homedir(), '.code2knowledge', 'config.yml'), fetchImpl = fetch } = {}) {
  if (!['intervention', 'completed'].includes(event) || !task || !summary || !Array.isArray(details)) throw Error('通知必须包含有效 event、task、summary 和 details 数组');
  // node:test propagates this context to spawned CLI children. Never use real transport in tests.
  if ((process.env.NODE_TEST_CONTEXT || process.env.C2K_NOTIFICATIONS_DISABLED === '1') && fetchImpl === fetch) return { status: 'skipped', reason: 'test_or_disabled' };
  const payload = { event, task, summary, details: details.filter(line => !String(line).startsWith('检查记录：')) };
  const id = hash(payload);
  const dir = path.join(workspace, 'notifications');
  await fs.mkdir(dir, { recursive: true });
  const recordPath = path.join(dir, `${id}.json`);
  const lockPath = `${recordPath}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return { status: 'in_progress', recordPath }; throw error; }
  try {
    try {
      const previous = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      if (previous.status === 'sent') return { ...previous, duplicate: true, recordPath };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let status = 'skipped', reason = 'not_configured';
    try {
      let config;
      try { config = parse(await fs.readFile(configPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const settings = config?.notification?.feishu;
      if (settings?.enabled === true) {
        const url = new URL(settings.webhook_url);
        if (url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) throw Error('invalid_config');
        const body = { msg_type: 'interactive', card: buildNotificationCard({ event, task, summary, details, test }) };
        if (settings.secret) {
          body.timestamp = String(Math.floor(Date.now() / 1000));
          body.sign = crypto.createHmac('sha256', `${body.timestamp}\n${settings.secret}`).update('').digest('base64');
        }
        const response = await fetchImpl(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) throw Error('http_error');
        const result = await response.json();
        if (result.code !== 0 && result.StatusCode !== 0) throw Error('provider_rejected');
        status = 'sent'; reason = null;
      }
    } catch { status = 'failed'; reason = '配置、网络或飞书响应异常；请检查本机通知配置及机器人状态'; }
    // Do not persist webhook, secret, response body or potentially sensitive error messages.
    const record = { id, event, task, status, reason, timestamp: new Date().toISOString() };
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    return { ...record, recordPath };
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
