# Changelog

## 0.1.2 — 2026-11-06

- 支持 DSH 0.2.2-rc.1 使用的 Cordis 4.1 与 Schemastery 3.19，同时保留旧版宿主的依赖范围。
- 修复不同 DSH 宿主所固定的 Zod 小版本与插件 JSON Schema 转换之间的兼容问题，保留输入与结果校验。
- 新增英文 README，补充安装、会话授权、只读边界和数据处理说明。
- 明确维护者、源码仓库与 npm 包关联，完善包描述及检索关键词。
- 将英文 README 纳入发布产物，并补充 MCP 输入 schema 与非法调用拒绝的回归测试。

## 0.1.1 — 2026-10-21

- 修复更新 DeepSeek Harness 后插件无法安装的问题。

## 0.1.0 — 2026-10-20

首次发布。

- 管理 MySQL、MariaDB、PostgreSQL、SQL Server、Oracle、MongoDB 的受控只读连接。
- 每连接提供结构发现与只读查询 MCP 工具，支持可信会话授权、子 Agent 继承、共享额度、元数据缓存和有界结果。
- DSH Web 提供连接设置、测试、诊断、Agent 访问开关和脱敏调用记录；连接配置与凭据持久化保存。
- 新连接默认关闭 Agent 访问并启用 TLS 校验；密码交由宿主 credentials 服务保管。
- 停用、删除、配置变更及卸载撤销工具并回收所属工作；取消结果区分客户端关闭与服务端终止证据。
- 采用 MIT 许可证，提供独立安装验收和标签发布工作流。

本次验证基线为 DSH 0.2.0-rc.2、Node.js ≥22.19、Web Profile。已验证范围与限制见 [兼容性](docs/compatibility.md)。
