import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function ensureConfig({ userHome = os.homedir(), dryRun = false } = {}) {
  const configPath = path.join(userHome, '.code2knowledge', 'config.yml');
  if (!dryRun) {
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const template = await fs.readFile(new URL('../../assets/notification-config.example.yml', import.meta.url), 'utf8');
    try { await fs.writeFile(configPath, template, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return configPath;
}
