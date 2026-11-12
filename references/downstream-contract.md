# 下游接入契约

这是对文档站、RAG 和 MCP 接入方的要求，不代表 Code2Knowledge 已实现这些服务。格式为通用 Markdown/YAML，不绑定 Onyx 或 knowledge-rag-plus。

## 接收与索引

解析业务 Markdown frontmatter 与业务 YAML meta，保存 schema_version、knowledge_id、product、domain、systems、knowledge_type、sources、generated_at、owner、review_status、lifecycle。类型约束/维护资料按 knowledge_type 单独识别，不作为普通业务事实。

按稳定 knowledge_id 更新记录，文件移动不能产生第二份知识；业务条目按稳定业务 ID 建立引用。sources 必须保留所有仓库版本与工作区状态，资料保留 document_id/path/sha256。不要在导入时把 pending 自动变成 confirmed。

## 分块

每块继承知识 ID、业务域、系统、来源版本、文件及条目审核状态、生命周期；保留适用条件和限制。按流程/规则/能力的语义边界分块，不把结论与证据断开。需要展开引用时按稳定 ID 获取权威规则，不凭“上述规则”补猜上下文。

VERIFIED 是代码核验状态，review_status 是人工业务审核状态。文件 pending 可以含局部 VERIFIED 条目；confirmed 文件也不能掩盖其中的 pending/UNVERIFIED 条目。needs_review/deprecated/rejected 不作为当前确定事实，是否展示历史记录由下游明确决定。

## MCP 返回

检索结果至少返回：内容、knowledge_id、业务条目 ID、product/domain/systems、claim_type/status/review_status/lifecycle、适用条件与限制，以及可复查的 repository/commit/path/symbol/lines/supports 或资料指纹和定位。若生成源码链接，只能使用经过授权、无认证信息的仓库地址映射；不暴露本机路径。

## 权限与发布

元数据标签不等于员工权限。身份认证、数据权限、检索过滤、审计、Embedding、发布门禁由下游实现；不能仅凭 product/domain 标签认定某位员工有访问权限。Code2Knowledge 导出成功只表示交付了本地资产，不代表已导入索引、通过业务审核或向员工发布。
