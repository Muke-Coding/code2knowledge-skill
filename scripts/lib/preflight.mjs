import { notify } from './notify.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function requireDocumentChoice(payload) {
  if (!Object.hasOwn(payload, 'rawDocsDir') || typeof payload.rawDocsDir !== 'string') throw Error('需要人工选择文档资料：显式提供 rawDocsDir（不添加时为空字符串）');
}
export async function syncMaster(repoDirs, { inspect, workspace }) {
  const report = { checkedAt: new Date().toISOString(), status: 'running', repositories: [] };
  const git = async (cwd, ...args) => (await exec('git', args, { cwd, timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  let step = '工作区检查', current;
  try {
    for (const dir of [...new Set(repoDirs)]) {
      current = { path: dir, status: 'pending' }; report.repositories.push(current);
      const info = await inspect(dir);
      if (info.worktreeStatus !== 'clean') throw Error('工作区不是 clean，保留改动并请求人工处理');
      current.originalCommit = await git(dir, 'rev-parse', 'HEAD');
      current.originalBranch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        const markerPath = await git(dir, 'rev-parse', '--git-path', marker);
        try { await fs.access(path.resolve(dir, markerPath)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        throw Error(`存在未完成 Git 操作：${marker}`);
      }
    }
    for (const item of report.repositories) {
      current = item; const dir = item.path;
      step = 'fetch origin/master';
      await git(dir, 'fetch', 'origin', '+refs/heads/master:refs/remotes/origin/master');
      const remote = await git(dir, 'rev-parse', 'refs/remotes/origin/master');
      let local;
      try { local = await git(dir, 'rev-parse', '--verify', 'refs/heads/master'); } catch { /* Create tracking branch below. */ }
      if (local) {
        step = 'master 快进可行性检查';
        await git(dir, 'merge-base', '--is-ancestor', local, remote);
      }
      step = '切换 master';
      if (local) await git(dir, 'switch', 'master');
      else await git(dir, 'switch', '--track', '-c', 'master', 'origin/master');
      step = 'pull master'; await git(dir, 'pull', '--ff-only', 'origin', 'master');
      step = '最终版本检查';
      item.commit = await git(dir, 'rev-parse', 'HEAD');
      if (item.commit !== await git(dir, 'rev-parse', 'refs/remotes/origin/master') || await git(dir, 'branch', '--show-current') !== 'master' || (await inspect(dir)).worktreeStatus !== 'clean') throw Error('master 版本或工作区状态不一致');
      item.status = 'passed';
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'blocked';
    if (current) { current.status = 'blocked'; current.step = step; }
    // Keep credentials from remote URLs out of persisted diagnostics.
    report.error = `master 检查失败：${step}；请人工检查仓库、分支、网络和权限，处理后重试`;
  }
  const dir = path.join(workspace, 'preflight'); await fs.mkdir(dir, { recursive: true });
  const recordPath = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`);
  await fs.writeFile(recordPath, JSON.stringify(report, null, 2));
  if (report.status !== 'passed') {
    try { await notify({ workspace, event: 'intervention', task: current?.path || workspace, summary: report.error, details: [`仓库：${current?.path}`, `检查记录：${recordPath}`] }); } catch { /* Preserve the original blocker. */ }
    throw Error(`${report.error}；仓库：${current?.path}；检查记录：${recordPath}`);
  }
  return { ...report, recordPath };
}
