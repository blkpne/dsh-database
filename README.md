# dsh-database

**在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中，让 Agent 按授权探索数据库并执行只读查询。**

通过 Web 界面管理连接，让 Agent 先了解表或集合的结构，再回答数据问题。支持 **MySQL、MariaDB、PostgreSQL、SQL Server、Oracle 和 MongoDB**。

[开始使用](#开始使用) · [使用指南](docs/usage.md) · [兼容性](docs/compatibility.md) · [参与贡献](CONTRIBUTING.md)

![数据库连接设置：连接名称、地址、只读账户、TLS 与 Agent 访问开关](docs/assets/connection-manager.jpg)

[查看配置原图](https://github.com/blkpne/dsh-database/raw/refs/heads/main/docs/assets/connection-manager.jpg) · 示例连接，不含真实凭据。

## 能做什么

- **连接数据库**：填写连接信息、测试认证，在同一界面管理多种数据库。
- **按需了解结构**：搜索表、视图和集合，查看字段、约束与索引，无需预先加载整个数据库的定义。
- **控制 Agent 访问**：连接默认关闭访问；可限定会话、只开放结构发现，并设置调用额度。
- **定位调用问题**：查看诊断、耗时、错误阶段和取消状态；调用记录不保存 SQL、参数或业务行。

本项目专注于只读数据访问。数据库账户也应配置只读权限；插件不提供写入、结果导出、SQL 历史重放或 SSH 隧道。凭据由 DSH 保存，新连接默认启用 TLS 证书校验。查询结果会进入 Agent 上下文，宿主会话和模型服务的数据处理范围见[查询数据如何使用](docs/usage.md#查询数据如何使用)。

## 开始使用

### 1. 安装插件

已安装 DSH 时，在终端执行以下命令，将插件直接安装到 `web` Profile。安装或更新前，请先停止正在运行的该 Profile：

```sh
dsh plugin --profile web add dsh-database@latest --ignore-scripts
```

命令从 npm 下载已构建的插件，无需克隆仓库或本地打包。更新插件也使用同一条命令，完成后重新启动 Web。

#### 安装 DSH

尚未安装 DSH 时，先运行：

```sh
npm install --global @deepseek-ai/dsh@latest
```

Node.js 要求和已验证的 DSH 版本见[兼容性](docs/compatibility.md#宿主与平台)。Windows PowerShell 可使用 `npm.cmd` 和 `dsh.cmd`。

### 2. 启动 Web

```sh
dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

`web` Profile 不存在时，DSH 会初始化它。打开终端输出的登录链接，侧栏应出现「数据库」。首次使用 DSH 时，按宿主提示完成模型配置。

### 3. 完成第一次查询

1. 打开「数据库」，创建连接，填写可访问的数据库地址、数据库名和只读账户。
2. 点击「测试当前配置」，成功后保存。私有 CA 的配置见 [TLS 连接](docs/usage.md#tls-连接)。
3. 在「授权规则」中选择访问范围并保存，再开启「Agent 访问」。
4. 在获授权的会话中提问，例如：

> 使用「业务分析库」列出我能访问的表。先查看相关字段，再统计订单数量，并说明使用了哪张表。

测试成功只代表当前配置可连接，不会自动保存或开启 Agent 访问。查询数据与分析结论在 Agent 对话中查看；「调用记录」用于查看状态、耗时和错误；完整操作见[使用指南](docs/usage.md)。

### 场景示例：电商经营复盘

订单增长，净收入为何增速放缓？Agent 先通过插件了解订单与退款表，在数据库端按月、按渠道聚合，再用结果生成趋势图、定位异常并给出经营建议。

![Agent 通过数据库插件查询电商订单与退款，展示经营指标、分析结论和图表](docs/assets/agent-analysis.jpg)

[查看完整对话原图](https://github.com/blkpne/dsh-database/raw/refs/heads/main/docs/assets/agent-analysis.jpg) · 真实 Agent 对话节选，数据为隔离 PostgreSQL 中的合成示例。

插件负责只读取数，Agent 使用宿主的文件与执行工具完成分析和绘图。操作与提问示例见[使用指南](docs/usage.md#场景示例电商经营复盘)。

## 遇到问题

| 现象                   | 先检查                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------ |
| 安装时提示找不到 pnpm  | DSH CLI 使用 pnpm 管理插件；仅在缺失时执行 `npm install --global pnpm@latest` 后重试 |
| 侧栏没有「数据库」     | 是否安装到正在使用的 Web Profile、是否重启、DSH 版本是否匹配                         |
| TLS 或证书错误         | 主机名是否匹配证书，宿主是否信任签发 CA；见 [TLS 连接](docs/usage.md#tls-连接)       |
| Agent 看不到工具       | 访问开关、已保存的授权范围、当前会话；仅结构发现模式不会提供查询工具                 |
| 查询被拒绝、结果不完整 | 查询是否只读，是否达到额度或结果上限；见[故障排查](docs/usage.md#故障排查)           |

## 继续阅读

| 我想……                           | 文档                                                      |
| -------------------------------- | --------------------------------------------------------- |
| 管理连接、调整授权、排查查询问题 | [使用指南](docs/usage.md)                                 |
| 查看工具参数、返回格式与限额     | [工具与结果参考](docs/reference.md#工具与结果参考)        |
| 更新、停用或卸载插件             | [维护插件](docs/usage.md#更新停用与卸载)                  |
| 复现电商分析场景                 | [合成数据与操作步骤](docs/examples/ecommerce/README.md)   |
| 备份数据或恢复环境               | [备份与恢复](docs/usage.md#备份与恢复)                    |
| 判断当前环境是否已验证           | [兼容性](docs/compatibility.md)                           |
| 修改代码、运行测试、参与贡献     | [贡献指南](CONTRIBUTING.md)                               |
| 查看版本说明与发布流程           | [CHANGELOG](CHANGELOG.md) · [发布指南](docs/releasing.md) |

## 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/blkpne/dsh-database/issues) 提出问题和需求，也欢迎改进文档、补充测试或提交修复。报告问题时，请提供版本、最小复现和脱敏错误信息，详见[反馈问题](CONTRIBUTING.md#反馈问题)。

安全问题请先阅读[安全报告指引](SECURITY.md)，不要在公开 Issue 中提交漏洞细节。

本项目由 [blkpne](https://github.com/blkpne) 维护，采用 [MIT](LICENSE) 许可证。
