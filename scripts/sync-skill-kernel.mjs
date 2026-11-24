/** 将唯一共享内核生成到显式Skill工作副本；镜像可独立打包，校验模式只读，禁止隐式定位个人安装目录。 */
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
/** 已安装的固定版本内核，仅从npm依赖生成宿主可读规范，不从开发源码复制运行代码。 */
const source = dirname(createRequire(import.meta.url).resolve('@code2knowledge/kernel/package.json'));
/** @param directory 内核受版本控制的目录 @param relative 目录内相对定位，缺省空 @returns 排序文件清单；不允许链接 @throws {Error} 源目录含符号链接或特殊节点 */
async function files(directory, relative = '') {
  const result = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(directory, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('共享内核源码不得包含链接或特殊文件');
  }
  return result.sort();
}
/**
 * @param skillRoot 显式Skill源码目录，必须是@code2knowledge/skill，不读取HOME。
 * @param check 是否仅检查生成一致性；缺省false生成已声明镜像文件。
 * @returns 固定管理文件数量，不输出用户配置；额外镜像文件也会拒绝。
 * @throws {Error} 目标身份、目录类型、镜像漂移或读取失败时停止。
 */
export async function syncSkillKernel(skillRoot, check = false) {
  const target = resolve(skillRoot); const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  if (pkg.name !== '@code2knowledge/skill') throw new Error('目标不是独立Skill包');
  const expected = new Map();
  for (const path of await files(join(source, 'references'))) expected.set(`references/${path}`, await readFile(join(source, 'references', path)));
  for (const path of await files(join(source, 'assets'))) expected.set(`assets/project-context/${path}`, await readFile(join(source, 'assets', path)));
  const hashes = Object.fromEntries([...expected].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')]));
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  expected.set('kernel-manifest.json', Buffer.from(JSON.stringify({ generated: 'scripts/sync-skill-kernel.mjs', kernelVersion: metadata.version, contractVersion: '2.0', files: hashes }, null, 2) + '\n'));
  // 仅管理镜像及白名单资源，未知镜像内容拒绝而非自动删除；生成路径的每级祖先不得为链接。
  for (const path of expected.keys()) {
    let current = target;
    for (const part of path.split('/')) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('生成目标不得为符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const [path, content] of expected) {
    if (check) { if (!(await readFile(join(target, path))).equals(content)) throw new Error(`共享内核镜像已漂移：${path}`); }
    else { await mkdir(dirname(join(target, path)), { recursive: true }); await writeFile(join(target, path), content); }
  }
  return expected.size;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--skill-root'); const target = process.argv[index + 1];
  if (index < 0 || !target || target.startsWith('--')) throw new Error('必须显式传入--skill-root，生成使用--write，检查使用--check');
  if (process.argv.includes('--write') === process.argv.includes('--check')) throw new Error('必须且只能选择--write或--check');
  console.log(`共享内核镜像${process.argv.includes('--check') ? '校验' : '生成'}完成：${await syncSkillKernel(target, process.argv.includes('--check'))}个文件`);
}
