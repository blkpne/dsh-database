# dsh-database 开发指引

本项目是独立的 DeepSeek Harness 插件。先读 README.md、CONTRIBUTING.md 与 docs/usage.md。独立克隆即可开发，不要求父目录指引、上游 checkout 或维护者私人配置；若当前任务另外提供工作空间指引，同时遵守它，不修改只读参考源码。

## 实现边界

- 每次宿主兼容性或发布任务核查 `@deepseek-ai/dsh` 主包的 npm latest，并使用该发行版匹配的公共组件。本次快照为 0.2.0-rc.2（2026-10-17）；不永久限定旧版本，也不逐个追随拆分包标签。
- `src/index.ts` 只装配 Host；`ports.ts` 定义接口；`manager.ts` / `runtime.ts` 管理持久化、凭据和生命周期；`query.ts` / `adapters/` 管理执行；`sql.ts` / `mongo.ts` 管理只读边界。`bridge.ts` / `mcp.ts` 适配宿主和协议，`client/` 只包含浏览器代码。
- 模型只调用受授权的 inspect/query，不读取或修改连接配置。身份取自可信 scope；密码仅进入宿主 credentials 服务。日志不包含 SQL、参数、业务行、凭据或原始驱动错误。
- 工具、通道、连接、路由、Client slot 随停用、删除、配置变更和卸载撤销；取消与释放客户端资源不等同于确认服务端停止。涉及生命周期时覆盖在途工作和恢复。
- 不开放写 SQL、任意多语句、文件读写或远程 MCP HTTP 端点。扩展产品权限前先更新边界与验证案例。
- 持久化变更同时考虑缺失字段读取、旧记录、凭据轮换和失败恢复。新增直接导入的包必须显式声明，不依赖传递依赖恰好被提升。

## 开发与验证

- Docker 是可选集成测试环境，不能作为安装、日常开发、基础检查、构建或打包的前置条件。
- `npm ci` 安装，`npm run check` 执行基础门禁，`npm run format` 统一格式。命令从本项目执行，具体平台和依赖见 CONTRIBUTING.md。
- Windows/macOS/Linux 日常 Web 使用 `npm run dev:web -- --no-open`，只挂载用 `npm run dev:mount`。默认复用 DSH_HOME（未设置为 ~/.dsh）的 web Profile 和 3080，保留 API Key、连接、会话及工作空间；先请求关闭原端口占用进程，等待 6 秒后按需强制结束，每次核对 PID 与启动时间，不换端口或广泛结束进程。Windows 使用系统 PowerShell/taskkill 和 `.cmd` 兼容启动器，macOS/Linux 使用 lsof/ps 与 SIGTERM/SIGKILL；具体关闭语义见 CONTRIBUTING.md。
- 新建、迁移、破坏性和凭据边界测试必须使用隔离 DSH_HOME、工作目录及所属容器，不往日常环境注入夹具。动态 Web 仍用 3080，结束后恢复日常 Profile。
- 自动测试输出默认 test-results/，可通过 DSH_DATABASE_TEST_ROOT 指向调用者选择的隔离目录。禁止硬编码维护者主目录、父仓库、历史日期或共享实验目录。
- 数据库测试优先 `npm run test:docker`，可用 `-- --engines mysql,postgresql` 选择。容器成功、失败及中断后回收，不操作现有数据库或全局 prune。异常后 `test:docker:cleanup` 只清理所属过期实例。
- 已有实例的 `test:mysql` / `test:engines` 及在线 `test:agent` 显式启用，变量见 CONTRIBUTING.md。缺失配置时的 SKIP 不记为兼容通过。在线评测的对比基线可选，不要求私有旧源码。
- 文档变更运行 `npm run check:docs` 核对格式、元数据和本地链接，另核对命令；行为变更跑受影响回归及必要门禁。不能以 HTTP 200、安装成功、驱动替身或类型检查代替真实数据库、浏览器或在线模型验收。
- README 保持不随版本迭代改写的安装与开发入口，远程安装使用 npm latest；具体版本要求与验证基线维护在 package.json 和 docs/compatibility.md。docs/ 不存放内部需求、设计草案和评审过程记录；公开文档使用显式 npm 发布白名单。

## 发布

采用 MIT。首版版本号为 0.1.0，文档只描述首版能力、使用方式和实际验证范围。候选先核对 README、CHANGELOG 日期和兼容性状态，通过 `npm run release:ready` 后再运行 `npm run test:pack` 独立构建、安装 tarball 并验证 Host/MCP/Client；`npm run audit:prod` 核查生产依赖。发布流程见 docs/releasing.md，兼容范围与限制写入 docs/compatibility.md。npm publish、git push 及仓库可见性变更分别遵循当前维护者授权。
