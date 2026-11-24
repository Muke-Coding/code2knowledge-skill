/** 共享逆向内核公开入口；两种宿主复用知识契约、维护模板和规范，不负责权限、Git、模型、向导或通知。 */
import { cp, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateContract } from './contract.mjs';
export * from './contract.mjs';
/** 内核与兼容产物版本分别固定；legacySkillVersion仅表示兼容基线，不表示本次实际运行了该Skill。 */
export const kernelCompatibility = Object.freeze({ kernelVersion: '0.1.0', contractVersion: '2.0', legacySkillVersion: '1.0.2' });
/** 安装包内固定资源根，不接受用户传入模块或远程定位。 */
const root = fileURLToPath(new URL('../', import.meta.url));
/**
 * @returns 固定顺序的逆向、知识模型和下游规范正文；不读取Skill入口或用户配置。
 * @throws {Error} 包内规范缺失或不可读时拒绝，不回退宿主旧版本。
 */
export async function readAnalysisGuidelines() {
  return Promise.all(['analysis.md', 'knowledge-model.md', 'downstream-contract.md'].map((file) => readFile(join(root, 'references', file), 'utf8')));
}
/**
 * @param destination 调用方明确准备的资产根目录；调用方负责目录许可与隔离。
 * @returns 复制ontology与rules维护模板并建立业务目录；已有维护文件不覆盖，不执行Git或通知。
 * @throws {Error} 模板缺失或目标不可写时拒绝；不承诺跨文件写入原子性。
 */
export async function writeMaintenanceTemplates(destination) {
  for (const directory of ['domains', 'graph/curated', 'mappings']) await mkdir(join(destination, directory), { recursive: true });
  for (const directory of ['ontology', 'rules']) await cp(join(root, 'assets', directory), join(destination, directory), { recursive: true, force: false, errorOnExist: false });
}
/**
 * @param root 调用方明确且有权读取的资产根，不从环境推导来源。
 * @param options 契约校验的显式选项；省略时不读取源码或相邻域。
 * @returns 保留旧错误报告并增加结构化诊断；BLOCKING阻断契约通过，WARNING不代表审核结论。
 * @throws {Error} 底层不可读等异常沿用validateContract行为，由入口处理人工介入。
 */
export async function inspectContract(root, options = {}) {
  const report = await validateContract(root, options);
  return { ...report, diagnostics: [
    ...report.errors.map((message) => ({ code: 'CONTRACT_INVALID', severity: 'BLOCKING', message })),
    ...report.warnings.map((message) => ({ code: 'CONTRACT_WARNING', severity: 'WARNING', message })),
  ] };
}
