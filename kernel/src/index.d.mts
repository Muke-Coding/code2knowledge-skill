/** 共享内核公开类型；入口身份、模型凭证和运行时租约不属于本契约。 */
/** 单仓固定来源；未知提交使用null，工作区状态缺省unknown。 */
export interface RepositorySource {
  /** 稳定仓库别名，不是本机定位。 */
  name: string;
  /** 完整Git提交；未知允许null。 */
  commit?: string | null;
  /** 分析时工作区状态；省略为unknown。 */
  worktreeStatus?: string;
}
/** 资料版本定位，不包含资料正文或绝对路径。 */
export interface DocumentSource {
  /** 稳定资料标识。 */
  document_id: string;
  /** 根内相对路径。 */
  path: string;
  /** 原始资料SHA256。 */
  sha256: string;
}
/** 模板输入；由入口冻结，不从用户全局配置读取。 */
export interface ContextInput {
  /** 产品目录标识。 */
  product: string;
  /** 业务域目录标识。 */
  domain: string;
  /** 固定代码来源；省略为空。 */
  repositories?: RepositorySource[];
  /** 固定资料来源；省略为空。 */
  documents?: DocumentSource[];
  /** 既有知识类型到稳定ID映射；省略为空。 */
  identities?: Record<string, string>;
  /** ISO生成时间；省略为当前时间。 */
  generatedAt?: string;
}
/** 完整报告中未经身份认证的知识元数据；不代表业务授权。 */
export interface ParsedAsset {
  /** 仅解析的未知值；可能为空、标量或数组，必须由validateContract或宿主Schema认证。 */
  meta: unknown;
  /** Markdown正文，仅Markdown提供。 */
  body?: string;
  /** 原始YAML或Markdown结构，不自动修复。 */
  value: Record<string, unknown>;
}
/** 原契约报告；保持2.0产物与旧入口兼容。 */
export interface ContractReport {
  /** 非空即禁止契约通过。 */
  errors: string[];
  /** 非阻断提醒，不表示业务审核通过。 */
  warnings: string[];
  /** 已读取资产摘要。 */
  assets: Record<string, unknown>[];
  /** 代码证据影响定位。 */
  impact: Record<string, unknown>[];
}
/** 用于匹配资产所属任务的目录标识；不是平台授权凭证。 */
export interface ValidationRun {
  /** 产品目录标识。 */
  productSlug: string;
  /** 业务域目录标识。 */
  domainSlug: string;
}
/** 调用方锁定的分析原料清单，不包含正文。 */
export interface MaterialSnapshot {
  /** 固定代码仓库与版本；资料任务允许空数组。 */
  repositories: RepositorySource[];
  /** 固定资料列表；省略表示没有资料。 */
  documents?: DocumentSource[];
}
/** 核验时仓库状态与锁定版本的比较结果。 */
export interface CurrentRepository {
  /** 与来源对应的仓库别名。 */
  name: string;
  /** 是否仍匹配固定原料版本。 */
  matches: boolean;
}
/** 校验时的可选来源约束；源码读取只通过调用方显式回调提供。 */
export interface ValidationOptions {
  /** 本次业务目录标识，用于阻止混域。 */
  run?: ValidationRun;
  /** 固定原料版本。 */
  material?: MaterialSnapshot;
  /** 当前仓库与固定版本是否一致。 */
  currentRepositories?: CurrentRepository[];
  /** 当前可访问相邻业务域根；省略不访问。 */
  peerRoot?: string;
  /** @param repository 稳定仓库别名 @param commit 完整固定提交 @param path 根内相对源码路径 @returns 对应文件正文；拒绝读取时抛错 */
  readCode?: (repository: string, commit: string, path: string) => Promise<string>;
}
/** 机器可读诊断；不得据此自动修改审核状态。 */
export interface ContractDiagnostic {
  /** 稳定契约问题分类，不使用错误正文作为代码。 */
  code: 'CONTRACT_INVALID' | 'CONTRACT_WARNING';
  /** 是否阻断本次契约检查。 */
  severity: 'BLOCKING' | 'WARNING';
  /** 原始问题说明，宿主负责合适的展示与脱敏。 */
  message: string;
}
/** 原报告加机器可读诊断；不替代人工审核。 */
export interface InspectedContract extends ContractReport {
  /** 按错误后提醒顺序排列的全部诊断。 */
  diagnostics: ContractDiagnostic[];
}
/** 分离代码发行、知识契约与旧封套兼容版本。 */
export interface KernelCompatibility {
  /** 当前共享代码发行版本。 */
  readonly kernelVersion: '0.1.0';
  /** 业务资产格式版本，独立于代码发行。 */
  readonly contractVersion: '2.0';
  /** 旧产物封套兼容基线，不代表实际执行的Skill版本。 */
  readonly legacySkillVersion: '1.0.2';
}
/** 固定且运行时冻结的兼容信息。 */
export const kernelCompatibility: KernelCompatibility;
/** 资产契约版本，与npm版本独立。 */
export const schemaVersion: '2.0';
/** 五类导出目录。 */
export const assetDirs: string[];
/** 完整Git提交格式。 */
export const fullCommit: RegExp;
/** @param value 明确字节或文本 @returns 小写SHA256 */
export function sha256(value: string | Uint8Array): string;
/** @param value 业务内容 @returns 排除审核字段后的指纹 */
export function contentHash(value: unknown): string;
/** @param repositories 代码来源，省略为空 @param documents 资料来源，省略为空 @returns 来源记录 */
export function sourceRecords(repositories?: RepositorySource[], documents?: DocumentSource[]): Record<string, unknown>[];
/** @param options 固定业务与来源 @returns 模板上下文，不含宿主配置 */
export function makeContext(options: ContextInput): Record<string, unknown>;
/** @param context 模板上下文 @param type 知识类型 @returns pending元数据 */
export function metadataFor(context: Record<string, unknown>, type: string): Record<string, unknown>;
/** @param type 结论类型，省略code_fact @returns 待核实且待审核结论 */
export function pendingClaim(type?: string): Record<string, unknown>;
/** @param meta 元数据 @param body 正文 @param refs 结论ID，省略为空 @returns 带frontmatter的正文 */
export function markdown(meta: Record<string, unknown>, body: string, refs?: string[]): string;
/** @param file 相对路径 @param content UTF8正文 @returns 原始结构 @throws {Error} 元数据格式不合法 */
export function parseAsset(file: string, content: string): ParsedAsset;
/** @param root 明确资产根 @param dirs 相对目录，省略五类 @returns 已排序相对文件 @throws {Error} 链接或不可读 */
export function assetFiles(root: string, dirs?: string[]): Promise<string[]>;
/** @param root 明确资产根 @returns 可解析稳定ID映射 */
export function existingIdentities(root: string): Promise<Record<string, string>>;
/** @param root 明确资产根 @param options 可选来源约束 @returns 完整报告 @throws {Error} 底层文件不可读 */
export function validateContract(root: string, options?: ValidationOptions): Promise<ContractReport>;
/** @param root 明确资产根 @param options 可选来源约束 @returns 原报告及结构化诊断 @throws {Error} 底层文件不可读 */
export function inspectContract(root: string, options?: ValidationOptions): Promise<InspectedContract>;
/** @param draftsDir 已建立资产目录 @param domainName 显示名称 @param context 固定上下文 @returns 仅写缺失骨架 @throws {Error} 写入失败 */
export function writeBusinessTemplates(draftsDir: string, domainName: string, context: Record<string, unknown>): Promise<void>;
/** @param destination 已获准资产根 @returns 生成目录及缺失维护模板 @throws {Error} 模板读取或写入失败 */
export function writeMaintenanceTemplates(destination: string): Promise<void>;
/** @returns 固定顺序分析、模型、下游规范 @throws {Error} 安装资源缺失 */
export function readAnalysisGuidelines(): Promise<string[]>;
