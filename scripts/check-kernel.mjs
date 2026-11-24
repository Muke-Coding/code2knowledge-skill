/** 独立Skill发行前的内核镜像门禁；只检查包内生成清单，不需要平台源码、模型、通知或用户配置。 */
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
/** Skill安装根，仅从当前脚本确定，不使用工作目录或HOME。 */
const root = fileURLToPath(new URL('../', import.meta.url));
/** @returns 清单版本与所有生成文件摘要均一致；通过不表示业务逆向质量通过 @throws {Error} 文件缺失、漂移、越界或兼容版本错误 */
async function check() {
  const manifest = JSON.parse(await readFile(join(root, 'kernel-manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(createRequire(import.meta.url).resolve('@code2knowledge/kernel/package.json'), 'utf8'));
  const skill = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const require = createRequire(import.meta.url); const yaml = JSON.parse(await readFile(require.resolve('yaml/package.json'), 'utf8'));
  if (skill.dependencies['@code2knowledge/kernel'] !== pkg.version || skill.dependencies.yaml !== pkg.dependencies.yaml || yaml.version !== pkg.dependencies.yaml) throw new Error('两入口必须使用同一精确YAML解析器版本');
  if (manifest.contractVersion !== '2.0' || manifest.kernelVersion !== pkg.version || pkg.name !== '@code2knowledge/kernel') throw new Error('内核兼容版本不匹配');
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (!/^(references\/|assets\/project-context\/)/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('非法生成清单');
    let current = root;
    for (const part of path.split('/')) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('生成镜像不能使用链接'); }
    if (createHash('sha256').update(await readFile(join(root, path))).digest('hex') !== expected) throw new Error(`共享内核生成文件已漂移：${path}`);
  }

}
await check();
console.log('共享内核镜像与固定版本检查通过');
