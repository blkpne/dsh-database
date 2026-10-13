# 贡献指南

[项目首页](README.md) · [使用指南](docs/usage.md) · [兼容性](docs/compatibility.md)

欢迎修复问题、改善文档、补充测试或讨论新能力。本仓库可以独立开发，所需代码、构建配置和夹具均在仓库内，无需克隆 DSH 上游或使用维护者的本机配置。

- [反馈问题](#反馈问题) · [开始开发](#开始开发) · [提交修改](#提交修改)。
- [本地 Web 开发](#本地-web-开发) · [测试分层与夹具](#测试分层与夹具)。
- [平台与额外依赖](#平台与额外依赖) · [代码导览](#代码导览)。

## 反馈问题

先搜索 [Issues](https://github.com/blkpne/dsh-database/issues) 中是否已有相同问题。新建报告时，尽量提供：

1. **环境**：插件、DSH、Node、数据库版本，以及操作系统。
2. **复现步骤**：最小配置和具体操作；使用合成数据替代业务数据。
3. **预期与实际结果**：脱敏错误码、执行阶段，以及必要的截图。
4. **已尝试的排查**：例如连接测试、诊断或更换测试账户的结果。

不要上传密码、登录 token、带认证信息的链接、业务行或完整 Profile。提出功能建议时，说明要解决的场景与当前阻碍即可，无需先给出实现方案。

安全问题请遵循[安全报告指引](SECURITY.md)，不要通过普通缺陷表单公开漏洞细节。仓库提供缺陷报告、功能建议表单和 PR 模板，按对应入口填写即可。

## 开始开发

准备 Node.js 22.19.0 或更高版本，建议 Node 24。依赖使用 npm 和仓库中的 `package-lock.json` 安装。

```sh
git clone https://github.com/blkpne/dsh-database.git
cd dsh-database
npm ci
npm run check
```

下载 ZIP 的用户解压后从 `npm ci` 开始。**基础开发与检查不需要 Docker、全局 DSH、数据库密码或模型密钥。** 首次安装依赖需要访问 npm registry；基础测试使用内存 SQLite、临时文件、子进程和 loopback 监听，不连接业务数据库。

打包或验证安装产物时运行：

```sh
npm pack
npm run test:pack
```

`npm pack` 自动构建并生成 `.tgz`；`test:pack` 会自行构建，在隔离目录安装实际 tarball，验证 Host/MCP/Client、持久化与卸载重载。后者需要 registry 网络访问，完成后清理安装目录，保留 tarball 和校验和。

每次构建先清理 `dist/`，构建产物不提交。项目没有 Git 安装时自动构建的 `prepare` 钩子；向 DSH 安装插件时使用 npm 包或本地 tarball。

需要手动安装本地构建时，先停止目标 Web Profile，再将下方路径替换为 `npm pack` 生成的 `.tgz` 文件的绝对路径：

```sh
dsh plugin --profile web add "/absolute/path/to/package.tgz" --ignore-scripts
```

安装后按 [README](README.md#2-启动-web) 启动 Web。

## 提交修改

从一个聚焦的问题开始。涉及新权限、新引擎或用户可见行为时，先在 Issue 中说明场景，有助于确定范围。

| 修改内容                 | 提交前验证                                         |
| ------------------------ | -------------------------------------------------- |
| 仅文档                   | `npm run check:docs`，并核对命令与描述是否符合实现 |
| 插件行为、类型或开发脚本 | 相关回归测试，再执行 `npm run check`               |
| 打包、入口或依赖         | 上述检查，加 `npm run test:pack`                   |
| 数据库协议、TLS、取消    | 对应引擎或协议测试，明确真实数据库与替身覆盖的区别 |
| Web 交互或持久化         | 按影响验证浏览器、重启、恢复或隔离；测试环境见下文 |

使用 `npm run format` 统一格式。修复缺陷时补充能复现问题的回归；不为纯文档变更运行数据库矩阵。

PR 描述应让维护者理解**原问题、修改后的行为、验证结果与未覆盖范围**。同时检查：

- 新增直接导入的依赖已声明，锁文件一并提交；不混用包管理器重写锁文件。
- 配置、数据格式或用户操作变化已更新对应说明；需要时写明恢复方式。
- 不包含生成物、业务数据、凭据或私人路径；日志和截图已脱敏。
- `docs/` 面向用户和贡献者，不提交内部设计草案、评审过程或实验报告。

公开文档的 npm 白名单由 `package.json` 与 `scripts/verify-pack.mjs` 维护。发布权限和版本标签由维护者管理，流程见[发布指南](docs/releasing.md)。

## 本地 Web 开发

按 [README](README.md#安装-dsh) 安装 DSH 后，在项目目录运行；CLI 还需 pnpm 可用，缺失时按 [README 排障说明](README.md#遇到问题)安装：

```sh
npm run dev:web -- --no-open
# 只挂载：
npm run dev:mount
```

命令复用已有的 `web` Profile 和 **3080**，保留 API Key、连接、会话与工作空间。默认 home 为 `~/.dsh`，也遵循已设置的 `DSH_HOME`。

脚本会先构建，再请求关闭目标端口的原监听进程；等待 6 秒后，必要时强制结束。每次结束前核对 PID 和启动时间；出现新的占用者就停止，不扩大范围或自动换端口。运行前请确认 3080 用于本次开发。

macOS/Linux 使用 SIGTERM/SIGKILL，Windows 使用 [taskkill 流程](#windows-powershell)。`dev:mount` 也会停止原监听进程，但不启动 Web。完整帮助：`npm run dev:web -- --help`。

| 环境变量                     | 默认值与用途                              |
| ---------------------------- | ----------------------------------------- |
| `DSH_HOME`                   | `~/.dsh`；宿主配置、凭据及 Profile 根目录 |
| `DSH_DATABASE_WEB_PROFILE`   | `web`；须为 Web Profile                   |
| `DSH_DATABASE_WEB_PORT`      | `3080`；Web 监听端口                      |
| `DSH_DATABASE_WEB_WORKSPACE` | 当前插件仓库目录；必须存在                |
| `DSH_DATABASE_TEST_ROOT`     | `test-results`；打包缓存与验证输出        |

新建、迁移、错误凭据及删除测试使用隔离 `DSH_HOME` 和工作目录；仅更换 Profile 名称不足以隔离 home 级配置和凭据。下面的 POSIX 示例每次创建全新目录，环境变量仅对本次命令生效。Web 仍用 3080，结束后恢复日常启动：

```sh
dsh_web_check_dir="$(mktemp -d)"
mkdir -p "$dsh_web_check_dir/workspace"
DSH_HOME="$dsh_web_check_dir/home" \
DSH_DATABASE_WEB_WORKSPACE="$dsh_web_check_dir/workspace" \
npm run dev:web -- --no-open
```

## 测试分层与夹具

按改动选择对应层级。Docker 仅用于真实数据库集成测试；显式运行 Docker 测试但缺少环境时会报错，不记为通过。

| 命令                                          | 覆盖内容                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run check:docs`                          | 格式、发布元数据、仓库内 Markdown 链接及标题锚点；不构建或运行数据库                                     |
| `npm run check`                               | 格式、发布元数据、类型、离线行为、开发脚本、构建与发布白名单                                             |
| `npm run test:pack`                           | 自行构建并安装实际 npm tarball，不依赖已有 dist                                                          |
| `npm run test:docker -- --engines postgresql` | 自动创建、初始化、读取和回收指定数据库的隔离容器                                                         |
| `npm run test:docker -- --verify-cleanup`     | 六库及 SIGTERM/SIGKILL 后的所属容器、匿名卷回收                                                          |
| `npm run test:tls:protocol`                   | 无 Docker 的 MySQL/PG 认证边界与 MongoDB/Oracle TLS 握手验证，包含证书身份、分片/合并及 OpenSSL 路径解析 |
| `npm run test:tls -- --engines postgresql`    | 真实数据库证书、身份与不降级验证                                                                         |
| `npm run test:docker:cleanup`                 | 只清理本工具标记且租期已过的测试容器                                                                     |
| `npm run test:profile`                        | 按 `DSH_DATABASE_TEST_PROFILE_LOG` 提供的本机启动日志验证 API 认证；不输出 token                         |

### 隔离数据库与夹具

容器每轮生成凭据，绑定随机 loopback 数据库端口，不依赖个人数据库。默认串行运行；失败返回非零，不静默跳过指定引擎。主入口可用 `--timeout 600` 指定每实例时限（1–1800 秒），镜像拉取另有超时。

夹具代码位于 `test/docker/`：

| 文件             | 职责               |
| ---------------- | ------------------ |
| `definitions.ts` | 镜像与资源预算     |
| `fixtures.ts`    | 合成数据与只读账户 |
| `scenarios.ts`   | 行为断言           |
| `lifecycle.ts`   | 创建与清理         |

其他集成与实验入口需要预先准备 `definitions.ts` 对应镜像。

`test/evaluation/evaluations.xml` 与 `cases.ts` 是受版本控制的合成题目/答案，`fixture.ts` 用内存 SQLite 核对真实 MCP 调用。它们是测试源数据，不是运行报告；SQLite 不作为产品数据库适配器。更改数据时同步更新答案及断言，不能修改预期值掩盖产品缺陷。

### 测试已有数据库

仅对获授权实例运行只读探测，凭据通过环境变量注入。未配置时命令明确 SKIP：

- MySQL：设置 `DSH_DATABASE_TEST_USER/PASSWORD`，可选 `HOST/PORT/DATABASE/TLS`（均使用 `DSH_DATABASE_TEST_` 前缀），运行 `npm run test:mysql`。
- 其他引擎：设置 `DSH_DATABASE_<ENGINE>_HOST`，ENGINE 为 `MARIADB/POSTGRESQL/SQLSERVER/ORACLE/MONGODB`；其余后缀 `PORT/USER/PASSWORD/DATABASE/TLS`。MongoDB 另支持 `AUTH_SOURCE/REPLICA_SET/SRV`。运行 `npm run test:engines`。

两个入口的 `TLS` 均默认 `true`，只接受字面值 `true` 或 `false`，拼写错误直接报错。只有本地受控的明文夹具才显式设置对应的 `TLS=false`，不会在 TLS 失败后自动重试明文；MongoDB SRV 要求 TLS。

使用私有 CA 时，在启动 Node 前设置 `NODE_EXTRA_CA_CERTS` 为 CA PEM 的绝对路径，并使用证书覆盖的主机名或 IP。以下示例假定凭据已通过环境变量提供，不写入命令或配置文件：

```sh
# 默认 TLS：DSH_DATABASE_TEST_HOST 应匹配证书身份
NODE_EXTRA_CA_CERTS=/absolute/path/to/test-ca.pem npm run test:mysql
# 仅用于本地明文夹具
DSH_DATABASE_TEST_HOST=127.0.0.1 DSH_DATABASE_TEST_TLS=false npm run test:mysql
```

PowerShell 使用 `$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\test-ca.pem'` 或 `$env:DSH_DATABASE_TEST_TLS = 'false'` 后运行 `npm.cmd run test:mysql`；测试结束后移除本次设置的环境覆盖。六库 Docker 夹具和产品连接的默认值不受这些测试变量影响。

### CI 如何选择检查

| 变更范围                                                                         | CI 检查                        |
| -------------------------------------------------------------------------------- | ------------------------------ |
| 仅根目录 README / CONTRIBUTING / AGENTS / CHANGELOG、`docs/` Markdown 或文档图片 | `check:docs`                   |
| 其他路径、无法确定比较范围的事件、发布标签                                       | 完整平台、tarball 和数据库矩阵 |

代码移入文档目录仍算代码变更。`validation` 汇总所选任务，可作为统一的必需状态检查；配置在 `.github/workflows/check.yml`，路径判定在 `scripts/ci-scope.mjs`。远程状态以实际 CI 结果为准。

### 可选在线模型与机制实验

<details>
<summary>需要真实模型或机制对比时展开；在线模型调用会消耗 API 额度</summary>

`npm run test:agent` 要求 `DSH_DATABASE_LIVE_EVAL=1` 和 `DEEPSEEK_API_KEY`，也可用 `DSH_DATABASE_EVAL_CREDENTIAL_FILE` 显式指定本地 credentials YAML。默认评测当前代码。可用 `DSH_DATABASE_EVAL_ENGINES` 选择引擎、`DSH_DATABASE_EVAL_MODEL` 指定模型、`DSH_DATABASE_EVAL_OUTPUT` 指定报告路径。仅向模型暴露新建合成夹具，会消耗 API 额度。

可选 `DSH_DATABASE_EVAL_BASELINE` 指向调用者提供的兼容插件源码入口，启用 A/B 比较；`DSH_DATABASE_EVAL_RESUME=1` 只复用同模型、同题目、同 baseline 源码的已成功基线记录。`DSH_DATABASE_EVAL_VERIFY=1` 先运行动态断言。全部六库共 20 题，每题 3 次，完整答案严格匹配；模型循环由脚本执行，不能代替 Web AgentLoop 验收。

`test:ablation` 比较生命周期回收、调用者额度、结构缓存和只读屏障，需要 PostgreSQL 镜像；`test:oracle:metadata` 比较固定约束查询形状，需要 Oracle 镜像。实验生成物保留在唯一目录中，不加入产品开关，不作为生产吞吐或所有部署场景的承诺。

</details>

## 平台与额外依赖

| 任务                             | 依赖与限制                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 安装、类型、基础回归、构建、打包 | Node/npm；Linux/Windows Node 22.19/24、macOS Node 24 的自动化验收见[兼容性](docs/compatibility.md#自动化验收)      |
| `dev:web` / `dev:mount`          | 全局 `dsh` 和 pnpm；Windows 使用系统 Windows PowerShell、Get-NetTCPConnection、taskkill；macOS/Linux 使用 lsof、ps |
| `test:dev-web`                   | 配置、命令、取消、端口重启与 PID 复用保护；Windows 执行真实端口测试，POSIX 缺少 lsof 时仅跳过真实端口测试          |
| `test:docker`                    | 本机 Docker 的 Linux 容器；SQL Server 需要原生 amd64，SQL Server/Oracle 需要至少 3.5 GiB Docker 内存               |
| `test:tls` / `test:tls:protocol` | OpenSSL；真实 TLS 另需 Docker；协议夹具包含 IPv6 loopback，环境必须启用 IPv6                                       |
| `test:agent`                     | 显式付费评测开关、DeepSeek API 密钥、本机 Docker 及对应数据库镜像                                                  |

ARM 开发者可先运行 `npm run test:docker -- --engines mysql,mariadb,postgresql,mongodb`；不因某引擎平台限制阻止编辑、基础检查或打包。完整六库门禁在 Linux amd64 CI 运行。PostgreSQL 测试同时运行[公开电商示例](docs/examples/ecommerce/README.md)，核对月度与渠道指标、只读权限及重复导入保护；可用 `npm run test:docker -- --engines postgresql` 单独复核。容器镜像有各自条款，运行前核对供应商要求。

### Windows PowerShell

Windows x64 的真实进程、`.cmd`、安装与打包检查已通过 CI，记录见[自动化验收](docs/compatibility.md#自动化验收)。人工 Web 操作的覆盖范围单独记录，不由 CI 结果推定。

安装满足上述版本要求的 Node.js 并重新打开终端后，从源码目录执行：

```powershell
node --version
npm.cmd ci
npm.cmd run check
npm.cmd run test:pack
```

显式使用 `.cmd` 选择 npm 安装生成的命令入口，避免 PowerShell 优先选择的 `.ps1` 被本机执行策略拦截；无需为此修改全局执行策略。基础检查不需要 Bash、WSL、Docker、OpenSSL 或管理员终端。Windows CI 的检查范围包含 DSH 原生依赖的加载与执行。

需要实际 Web 时，安装宿主后直接使用开发脚本。它与其他平台一样复用已有 `web` Profile、配置和 **3080**，构建完成后才停止原监听进程：

```powershell
# 尚未安装 DSH/pnpm 时执行一次；使用有全局 npm 安装权限的 Node 环境。
npm.cmd install --global @deepseek-ai/dsh@latest pnpm@latest
dsh.cmd --version
pnpm.cmd --version
npm.cmd run dev:web -- --no-open
# 只构建、停止原监听进程并挂载，不启动 Web：
npm.cmd run dev:mount
```

核对 DSH 版本与[兼容性](docs/compatibility.md)中的基线。脚本通过 `.cmd` 启动器处理命令和含空格路径，不修改 PowerShell 执行策略。

Windows 会查询监听 PID 并核对启动时间，先执行不带 `/F` 的关闭请求，等待 6 秒后才对仍是原进程的 PID 强制结束。控制台程序不一定支持正常关闭；希望在途工作正常结束时，可先在原终端 Ctrl+C。

脚本不按进程名批量结束，也不清理现有监听者的子进程树。权限不足时停止并报告，不自动提权。

被 Profile 引用的 tarball 位于开发产物目录，不要在使用期间删除。凭据、数据库和模型设置沿用 README。可选 TLS 测试要求 `openssl.exe` 在 PATH 且 IPv6 loopback 可用；可选 Docker 测试使用 Linux 容器模式，不使用 Windows 容器。

## 临时目录与本机配置

可保留的开发产物默认写入仓库内、被 Git 忽略的 `test-results/`。用 `DSH_DATABASE_TEST_ROOT` 覆盖根目录；相对路径相对本项目解析。release 包位于其 `release/` 子目录；TLS 与机制实验每次创建唯一目录。短生命周期 Host 夹具另用系统临时目录并在 finally 中清理。

例如，需要自选隔离位置时，可在 POSIX shell 中设置：

```sh
export DSH_DATABASE_TEST_ROOT="$(mktemp -d)"
npm run test:pack
```

PowerShell 可使用 `$env:DSH_DATABASE_TEST_ROOT = Join-Path $env:TEMP "dsh-database-tests"`。不要把测试数据、私钥、启动日志或环境变量文件提交到 Git。开发 Web 所用的 tarball 是 Profile 的依赖来源，仍在使用时不要删除其 artifacts 目录。

## 代码导览

先阅读 [使用协议](docs/usage.md) 与 [兼容范围](docs/compatibility.md)，按改动选择模块：

| 模块                                    | 职责                                   |
| --------------------------------------- | -------------------------------------- |
| `src/index.ts`、`src/ports.ts`          | Host 装配与模块间接口                  |
| `src/manager.ts`、`src/runtime.ts`      | 持久化、凭据、连接与工具生命周期       |
| `src/bridge.ts`、`src/mcp.ts`           | DSH 工具适配与每连接的 MCP 通道        |
| `src/policy.ts`、`src/limits.ts`        | 可信身份授权与共享额度                 |
| `src/query.ts`、`src/adapters/`         | 执行、数据库驱动与取消                 |
| `src/sql.ts`、`src/mongo.ts`            | 输入校验与只读边界                     |
| `src/inspect.ts`、`src/metadata-sql.ts` | 结构发现、权限可见性与缓存             |
| `src/observability.ts`                  | 脱敏调用记录与取消证据                 |
| `src/client/`                           | 浏览器界面，不引入 Host 驱动或凭据存储 |

新增引擎通常涉及 engines/schema、adapter、元数据模板、表单、Docker 定义/夹具及对应测试；调整持久化同时考虑旧字段读取、凭据回收与重启。跨模块接口集中于 `src/ports.ts`，通过接口和构造注入隔离存储、凭据与驱动。修改 Web 交互时同时关注请求状态、草稿生命周期与真实浏览器回归。

### MCP 工厂

`dsh-database/mcp` 导出 `createDatabaseServer(description, execute, mongo?, options?)`，返回 MCP Server。第一个参数是连接描述，第二个是 SQL executor，第三个可选参数是 MongoDB executor；第四个 options 可提供 `inspect`、`metadataOnly` 和 `authorize`。

transport 不作为工厂参数传入；调用方创建 server 后，通过 `await server.connect(transport)` 接入自己管理的 transport，并在结束时调用 `await server.close()`。

工厂不启动网络监听，也不构造 DSH 身份。外部 transport 所有者负责认证、可信 owner gate 和调用频次；executor 负责连接级只读、时间与容量预算。DSH 内部桥接已接入这些约束，模型不能修改。

### 宿主与驱动适配

升级 DSH 时，先查询主包的 npm latest，再核对该发行版的整套公共组件，不逐包追随各自标签。锁文件与[兼容性](docs/compatibility.md)记录当前基线。

TLS 身份检查集中在适配器中：MySQL/MariaDB 使用 mysql2 校验，并补充 3.24.4 缺失的 IP socket 主机上下文；PostgreSQL 通过公开 TLS 回调绑定配置的主机身份。驱动或 Node 升级后重跑相关 TLS 矩阵，错误输出保持脱敏。

## 上游参考

- [DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)：核对公共接口与目标发行版的实现。
- [DSH 打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)：Bundle、Profile 和发布产物。
- [MCP tools 契约](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：输入/输出 schema、结构化结果与取消边界。

滚动文档和默认分支不构成目标发行版的兼容证据；修改相关模块时结合锁文件与实际安装的宿主核对。
