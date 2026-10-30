# 发布指南

[项目首页](../README.md) · [贡献指南](../CONTRIBUTING.md) · [兼容性](compatibility.md)

本页面向有发布权限的维护者，说明发布准备、产物验收和 npm 分发流程。命令以 **0.1.0** 为例，执行时版本、Git 标签和 `package.json` 必须一致。普通使用和开发分别从 README、贡献指南开始。

发布顺序：**确认权限 → 整理候选 → 本地验收 → 推送标签 → 验收 registry 产物**。

> **推送 `v0.1.0` 会触发自动 npm 发布。** 工作流没有额外人工审批步骤；推送 main、本地创建标签都不会发布 npm 包。Git 推送、npm 发布和仓库可见性变更分别按维护者授权执行。

## 1. 确认发布条件

- 维护者拥有 npm 包 `dsh-database` 的发布权限，目标版本可用于发布；npm 不允许覆盖同一版本。
- GitHub 仓库公开；工作流要求公开仓库以生成 npm provenance，并会阻止私有仓库发布。
- 从无维护者凭据的环境检查[贡献指南](../CONTRIBUTING.md#开始开发)中的克隆地址，以及仓库 ZIP 下载与 Issue 页面可访问。
- npm Trusted Publisher 指向本仓库的 `publish.yml`，配置如下。

如果采用私有仓库，应先确定分发方案并调整工作流。创建信任配置之前，建议先完成候选的本地准备，避免配置过期。

### 配置 npm Trusted Publisher

在 [npm 包设置](https://www.npmjs.com/package/dsh-database/access)中填写：

| 字段                 | 值                             |
| -------------------- | ------------------------------ |
| Provider             | GitHub Actions                 |
| Organization or user | `blkpne`                       |
| Repository           | `dsh-database`                 |
| Workflow filename    | `publish.yml`                  |
| Environment name     | 留空                           |
| Allowed actions      | 允许 `npm publish`（直接发布） |

字段区分大小写，文件扩展名也需一致。工作流使用 Node 24、npm 11、`id-token: write` 和 provenance，无需长期 `NPM_TOKEN`。

按 [npm 官方说明](https://docs.npmjs.com/trusted-publishers/)（2026-10-17 核查），新配置需在 2 天内首次发布成功；过期后删除并重新配置。保存设置不验证信任关系，首次成功发布才能证明 OIDC 配置有效。

## 2. 整理发布候选

先查询 `@deepseek-ai/dsh` 主包的 npm latest，并核对对应的整套公共组件。验证基线见[兼容性](compatibility.md)，不单独追随拆分包的 latest。

候选文件应满足：

| 文件                                | 核对内容                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `package.json`、`package-lock.json` | 版本与目标发布版本一致，许可证均为 MIT                                                         |
| `CHANGELOG.md`                      | 记录该版本的用户可见能力与实际日期，不写开发过程叙述                                           |
| `README.md`                         | 默认使用 `dsh-database@latest` 远程安装；源码与本地 tarball 操作放在贡献指南，不写发布进度通知 |
| `docs/compatibility.md`             | 记录版本、测试环境及覆盖边界；不从安装成功或 CI 配置推定兼容性                                 |
| 发布文件                            | 新增公开文档已列入 `package.json` 与 `scripts/verify-pack.mjs` 的白名单                        |

文档整理必须早于最终打包。npm 包页面的 README 随包发布，[单独修改 GitHub 文件不会更新已发布包的 README](https://docs.npmjs.com/about-package-readme-files/)。

## 3. 完成本地验收

在项目目录执行：

```sh
npm ci
npm run check
npm run audit:prod
npm run release:ready
npm run test:pack
npm run test:compat
```

| 检查            | 确认的内容                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| `check`         | 格式、本地文档链接、版本/许可证、类型、离线回归、开发脚本、构建与发布白名单 |
| `audit:prod`    | 生产依赖审计                                                                |
| `release:ready` | 检查日期格式及预设的文档状态标记；安装说明和验收证据仍需人工复核            |
| `test:pack`     | 实际 tarball 可独立安装，Host/MCP/Client、写入拒绝、持久化及卸载重载通过    |

这些检查不需要 Docker。`test:pack` 需要 registry 网络访问，会安装锁文件中的精确宿主组件；安装目录自动清理，tarball 和 SHA-256 留在 `test-results/release/`。可通过 `DSH_DATABASE_TEST_ROOT` 改变产物根目录。

### 数据库与 Web 验收

具备环境时，运行对应额外检查；完整数据库矩阵也是发布 CI 的必需任务：

```sh
# OpenSSL + IPv6 loopback，无需 Docker
npm run test:tls:protocol

# 真实数据库；需要 Docker
npm run test:docker -- --verify-cleanup
npm run test:tls
```

完整六库测试需要原生 amd64、Linux 容器和至少 3.5 GiB Docker 内存。供应商镜像遵循各自条款；测试只操作合成数据及所属容器、匿名卷。更多环境要求见[贡献指南](../CONTRIBUTING.md#平台与额外依赖)。

Web 验收使用全新的隔离 `DSH_HOME` 和工作目录，按[本地 Web 开发](../CONTRIBUTING.md#本地-web-开发)运行，检查认证、有效配置、Host 与浏览器 Client。开发脚本使用 3080 并重启目标监听进程；完成后恢复日常 `web` Profile。

tarball 安装检查不替代真实数据库、浏览器或完整 Web Profile 验收。分别记录 CLI 启动器、宿主组件版本与[验证边界](compatibility.md)。

## 4. 提交候选并推送标签

先审查和提交全部候选文件，确认 main 包含完整发布内容且工作区干净。

**已取得本次 npm 发布授权后**执行：

```sh
git status --short
npm run release:ready
git push origin main
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

`git status --short` 应无输出；未提交文件不会随标签发布。`v0.1.0` 必须对应 `package.json` 的 `0.1.0`，npm dist-tag 为 `latest`。

### 标签工作流会做什么

[check.yml](https://github.com/blkpne/dsh-database/blob/main/.github/workflows/check.yml) 提供共享验收，[publish.yml](https://github.com/blkpne/dsh-database/blob/main/.github/workflows/publish.yml) 强制运行完整矩阵。即使候选只修改文档，发布标签也不会跳过数据库或平台检查。

| 阶段         | 内容                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| 平台检查     | Linux / Windows 的 Node 22.19.0、24，以及 macOS Node 24；运行 check、生产依赖审计、tarball 安装 |
| 数据库与 TLS | Linux Node 24 运行六库、故障清理和 TLS；Windows Node 24 另运行 TLS 协议测试                     |
| 汇总         | `validation` 要求所选任务全部成功；失败、取消或意外跳过均不能放行                               |
| 保存产物     | Linux Node 24 的 tarball 和校验和上传为 `release-package`，保留 14 天                           |
| 发布         | 校验 SHA-256、完整 manifest，以及 README/CHANGELOG/兼容性文档与发布提交一致，再发布同一 tarball |

版本、许可证和发布文档在构建前检查。发布任务不会重新构建或换目录打包。远程 runner、OIDC 与 npm 发布状态需以实际工作流结果为准。

## 5. 验收 npm 安装

发布成功后核对 registry：

```sh
npm view dsh-database@0.1.0 version license dist.integrity
npm view dsh-database dist-tags
```

在**新的隔离 `DSH_HOME` 和工作目录**中安装 registry 产物。以下 POSIX 示例用子 shell 限定环境变量和工作目录；执行前先正常停止占用 3080 的 Web，结束后恢复日常 Profile：

```sh
(
  dsh_release_check_dir="$(mktemp -d)"
  mkdir -p "$dsh_release_check_dir/workspace"
  export DSH_HOME="$dsh_release_check_dir/home"
  cd "$dsh_release_check_dir/workspace" || exit 1
  dsh plugin --profile web add dsh-database@0.1.0 --ignore-scripts &&
    dsh --profile web --host 127.0.0.1 --port 3080 --no-open
)
```

Windows 用户在独立 PowerShell 终端中设置 `$env:DSH_HOME` 为全新目录，进入单独的测试工作目录，再运行同样的安装和启动命令（使用 `dsh.cmd`）。关闭该终端即可结束环境变量覆盖。

确认侧栏入口、默认关闭的 Agent 访问、默认开启的 TLS、授权查询和重启恢复。使用合成数据及获授权测试账户，完成后退出隔离环境并恢复日常配置。

保存 registry 版本、完整性值、验收环境与结果，作为该版本的发布验收记录。只有新增测试证据或支持范围变化时才更新兼容性说明；README 始终使用 `dsh-database@latest`，无需随发布阶段切换文案。已发布的 tarball 不会随仓库文档修改而改变。

## 发布失败时

| 情况               | 处理                                                            |
| ------------------ | --------------------------------------------------------------- |
| 检查失败           | 修复后重新验证，不绕过失败任务                                  |
| OIDC 认证失败      | 核对仓库、workflow 文件名、权限和配置有效期；以实际远程运行确认 |
| 版本已被发布       | npm 同版本不能覆盖，先核对已发布产物，再决定后续处理            |
| 安装后出现严重问题 | 停用插件，停止共享数据的 Host，在隔离环境验证备份恢复           |

安装前按[备份与恢复](usage.md#备份与恢复)保存同一时间点的配置、连接、运行记录和凭据；只复制 Profile 不足以恢复。恢复前确认目标插件与备份数据格式兼容；没有经过验证的回退版本时，先停用插件并验证备份恢复。备份只保存在用户受控位置。

官方参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows)、[DSH 打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。
