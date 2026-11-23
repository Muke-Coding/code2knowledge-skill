/** 独立Skill发行前的内核镜像门禁；只检查包内生成清单，不需要平台源码、模型、通知或用户配置。 */
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
/** Skill安装根，仅从当前脚本确定，不使用工作目录或HOME。 */
const root = fileURLToPath(new URL('../', import.meta.url));
/** @param directory 镜像内目录 @returns 全部普通文件，不跟随链接 @throws {Error} 特殊节点拒绝打包 */
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('内核镜像不能包含链接或特殊节点');
  }
  return result;
}
/** @returns 清单版本与所有生成文件摘要均一致；通过不表示业务逆向质量通过 @throws {Error} 文件缺失、漂移、越界或兼容版本错误 */
async function check() {
  const manifest = JSON.parse(await readFile(join(root, 'kernel-manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(root, 'kernel/package.json'), 'utf8'));
  const skill = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const require = createRequire(import.meta.url); const yaml = JSON.parse(await readFile(require.resolve('yaml/package.json'), 'utf8'));
  if (skill.dependencies.yaml !== pkg.dependencies.yaml || yaml.version !== pkg.dependencies.yaml) throw new Error('两入口必须使用同一精确YAML解析器版本');
  if (manifest.contractVersion !== '2.0' || manifest.kernelVersion !== pkg.version || pkg.name !== '@code2knowledge/reverse-kernel') throw new Error('内核兼容版本不匹配');
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (!/^(kernel\/|references\/|assets\/project-context\/)/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('非法生成清单');
    let current = root;
    for (const part of path.split('/')) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('生成镜像不能使用链接'); }
    if (createHash('sha256').update(await readFile(join(root, path))).digest('hex') !== expected) throw new Error(`共享内核生成文件已漂移：${path}`);
  }
  for (const path of await files(join(root, 'kernel'))) {
    const relative = path.slice(root.length).replaceAll('\\', '/');
    if (!Object.hasOwn(manifest.files, relative)) throw new Error('内核镜像存在清单之外的文件');
  }
}
await check();
console.log('共享内核镜像与固定版本检查通过');
