# 工具与配置参考

[项目首页](../README.md) · [使用指南](usage.md) · [兼容性](compatibility.md)

本页供需要查看工具输入输出、调整宿主配置或接入代码的用户查阅。日常使用只需在已授权的会话中向 Agent 提问。

- [工具与结果参考](#工具与结果参考)：结构发现、SQL、MongoDB、结果上限与取消。
- [Host 配置与持久化](#host-配置与持久化)：并发、存储隔离与接入方式。
- [授权与记录机制](#授权与记录机制)：可信身份、调用关联与写入失败处理。

## 术语

| 术语      | 含义                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| Host      | 正在运行的 DSH 宿主进程，负责插件、会话和数据库访问。                                 |
| Profile   | 一组宿主配置与插件依赖，例如 `web`；名称不同不一定意味着数据存储隔离。                |
| MCP       | Model Context Protocol，插件向 Agent 提供数据库工具所采用的协议。                     |
| PTC       | Programmatic Tool Calling，由宿主程序化调用工具的方式；与普通工具调用共用授权和额度。 |
| namespace | 插件存储数据的命名空间；同一存储后端可按它隔离数据。                                  |
| revision  | 连接配置的修订编号，用于识别过期配置和关联调用。                                      |

## 工具与结果参考

一般使用只需在获授权会话中描述问题：

> 使用「业务分析库」查看可访问的表或集合。确认结构后，按月份汇总我指定的数据，并说明查询条件。

启用连接后，Agent 获得以下工具。连接改名不会改变工具标识。

| 工具                           | 何时可用               | 用途         |
| ------------------------------ | ---------------------- | ------------ |
| `mcp__dshdb_<连接ID>__inspect` | 连接启用且调用者获授权 | 按需发现结构 |
| `mcp__dshdb_<连接ID>__query`   | 额外允许只读查询       | 读取业务数据 |

### 结构发现

inspect 包含四个动作，通常先定位命名空间和对象，再读取结构：

| 动作           | 用途                          | 结果与注意事项                                 |
| -------------- | ----------------------------- | ---------------------------------------------- |
| `capabilities` | 了解可用能力与预算            | 不连接数据库，不能用于健康检查                 |
| `namespaces`   | 列出可见 catalog/schema/owner | 可用 `name` 字面片段过滤，沿 `nextOffset` 翻页 |
| `search`       | 按字面名称片段搜索对象        | 每页 1–100 个，沿 `nextOffset` 翻页            |
| `describe`     | 按精确名称读取结构            | `refresh:true` 跳过已有缓存                    |

调用示例，每个代码块代表一次独立调用：

```json
{ "action": "capabilities" }
```

```json
{ "action": "namespaces", "limit": 30 }
```

```json
{ "action": "search", "name": "orders", "schema": "public", "limit": 30 }
```

```json
{ "action": "describe", "name": "orders", "schema": "public", "refresh": true }
```

search 支持 `type: table|view|collection`，名称和 schema 通过驱动绑定参数。数据库范围有以下差异：

- MySQL/MariaDB 返回可见库，支持切换 `catalog`；其他引擎限当前数据库或服务。
- PostgreSQL 返回有 USAGE 的非系统 schema；SQL Server/Oracle 返回有可见对象的 schema/owner。SQL 默认当前 schema，Oracle 默认当前 USER；跨 owner 时显式填写 `schema`。
- MongoDB 只列配置数据库，不访问其他库；此列表不证明连接或权限正常。集合游标分页沿服务端顺序，不保证跨次调用的稳定快照。

**如何理解结构结果：**

| 内容              | 约定                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| SQL 列与约束      | 返回列、可空性、原生默认值/注释、键与索引；Oracle 外键在 `foreignKeys`，SQL Server 主键在 `indexes.is_primary_key` |
| MongoDB 结构      | 返回集合定义、validator 与索引；无 validator 时标明结构未知，不采样文档                                            |
| section 状态      | `available/empty/denied/unsupported`；`empty` 仅表示没有可见元数据，不能证明对象不存在或未声明约束                 |
| 默认值与注释      | 原生值为 null 表示没有定义；权限错误与空结果分开返回，但数据库隐式过滤仍可能产生空结果                             |
| PostgreSQL 列权限 | 只返回可读列，并要求 schema USAGE；只有列授权时，整表的键、索引和注释标记 `denied/METADATA_PARTIAL`                |

元数据每节最多 500 行，完整结构化结果最多 256 KiB，与业务查询行数上限独立。检查 `truncated`、`truncationReason` 和 `nextOffset`；describe 的超大对象可能不完整，插件不会自动 COUNT 或采样补齐。

每个连接运行实例的缓存最多 64 项 / 2 MiB，TTL 为 60 秒。缓存按可信顶层调用者隔离，子 Agent 与所属会话共享。配置或策略变更会替换实例；外部数据库授权变化在 `refresh:true` 或 TTL 到期后反映。

### SQL 数据库

输入 `{ "sql": "SELECT ..." }`，单次仅一条语句：

- MySQL/MariaDB：SELECT、WITH、受限 SHOW、DESCRIBE、EXPLAIN SELECT。可用 SHOW DATABASES、SHOW TABLES、DESCRIBE 发现结构。
- PostgreSQL：SELECT、WITH、EXPLAIN SELECT；通过 `information_schema.tables/columns` 发现结构。
- SQL Server：SELECT、WITH；通过 `INFORMATION_SCHEMA.TABLES/COLUMNS` 发现结构。精确小数/金额列须显式 `CAST(amount AS varchar(100))`，否则返回 `UNSUPPORTED_TYPE`，避免 Tedious 已转换为 JS number 后静默丢失精度。
- Oracle：SELECT、WITH；通过 `all_tables/all_tab_columns` 发现结构。常量查询使用 `SELECT 1 FROM DUAL`。

禁止写入、多语句、锁定读取、文件/外部访问的已知内置函数、变量赋值、执行注释和优化器提示。SQL Server 查询还经过 T-SQL 语法解析，只接受单条 SELECT/CTE（可包含子查询和集合运算），并拒绝显式锁提示。校验器保守拒绝部分合法语法，包括解析器不支持的 T-SQL 写法、PostgreSQL dollar quoting、Oracle q quoting。不执行事务控制、存储过程或任意用户命令。

### MongoDB

输入结构化 JSON，不接受 SQL 或 JavaScript shell：

```json
{ "operation": "listCollections" }
```

```json
{
  "operation": "find",
  "collection": "orders",
  "filter": { "status": "paid" },
  "projection": { "_id": 0, "amount": 1 },
  "sort": { "amount": -1 },
  "limit": 20
}
```

```json
{
  "operation": "aggregate",
  "collection": "orders",
  "pipeline": [
    { "$match": { "status": "paid" } },
    { "$group": { "_id": "$region", "total": { "$sum": "$amount" } } }
  ]
}
```

`count` 接受 `collection/filter`。filter 支持 Extended JSON v2，例如 `{ "_id": { "$oid": "0123456789abcdef01234567" } }`。每个操作只接受自身字段；`limit` 仅用于 find/aggregate，仍受连接行数上限约束。

聚合阶段白名单：

```text
$match  $project  $group  $sort  $limit  $skip  $unwind  $count
$addFields  $set  $unset  $replaceRoot  $replaceWith  $sortByCount  $facet
```

`$set/$unset` 仅变换返回文档。拒绝 `$out/$merge`、服务端 JavaScript、非白名单阶段、任意 command 和跨集合 `$lookup`；嵌套 facet 也校验，禁用磁盘溢写。

### 结果格式与大小限制

查询返回统一结构：

```text
{ columns, rows, rowCount, truncated, durationMs, readOnly }
```

`rows` 使用数组行，以保留重复列名。MongoDB find/aggregate 返回 `document` 单列，并以 canonical Extended JSON v2 保留 ObjectId、Date、Long、Decimal128 等类型；count 返回计数，listCollections 返回名称。

| 限制           | 默认值  | 最大值或说明                                          |
| -------------- | ------- | ----------------------------------------------------- |
| 查询返回行数   | 500     | 5000，可在连接设置中调整                              |
| 查询超时       | 15 秒   | 60 秒，可在连接设置中调整                             |
| 连接总数       | —       | 20                                                    |
| 返回结果大小   | 256 KiB | 含 envelope 预留，不含 MCP text 副本和协议外壳        |
| 单元格大小     | 64 KiB  | 超限时整行省略                                        |
| 单元格嵌套深度 | 30 层   | 超深、循环或含访问器的值整行省略；不执行自定义 toJSON |

查询与元数据的截断原因包括 `row_limit/byte_limit/cell_limit/unsupported_value`。超限时省略整行并标记 `truncated`；**被截断的零行结果不能解释为空表。**

MySQL 大整数/DECIMAL、PostgreSQL bigint/numeric、Oracle NUMBER 保留字符串精度。PostgreSQL 日期、时间及 JSON/JSONB 使用原始文本；bigint、numeric、date、timestamp、timestamptz、JSON/JSONB 的数组也返回 PostgreSQL 原始数组文本，保留精度、维度和 NULL 信息。SQL Server 精确小数/金额须显式转为文本。二进制值使用 `{encoding:"base64",data}`。

返回预算不限制数据库服务器的计算量，也无法消除驱动接收单包、LOB 或单文档的内存开销。Oracle 每批最多拉取 32 行；MongoDB/SQL 查询使用游标或行事件。并发限制见 [Host 配置](#host-配置与持久化)。

### 超时与取消

| 引擎            | 实现方式与限制                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| MySQL / MariaDB | 同账户短连接执行 `KILL QUERY`，最多等待 1 秒后关闭原连接；控制连接不可用或被代理拒绝时，不能保证立即终止服务端计算 |
| PostgreSQL      | 独立短连接执行 `pg_terminate_backend`，终止本次查询独占的会话；失败时由服务器 `statement_timeout` 兜底             |
| SQL Server      | 使用 `request.cancel`                                                                                              |
| Oracle          | 使用 `break`                                                                                                       |
| MongoDB         | 使用 AbortSignal、游标关闭与 maxTimeMS                                                                             |

Oracle、SQL Server 在连接尚未建立时，可能需要等待连接超时，向上取整为秒、上限 10 秒；晚到的连接仍由插件清理。上述实现方式与[已完成的服务端验收](compatibility.md#取消与部署范围)分别说明。

## Host 配置与持久化

### 并发配置

在 Profile 的 `dsh-database` 行设置：

| 字段                      | 默认值 | 范围  | 用途                                 |
| ------------------------- | -----: | ----- | ------------------------------------ |
| `maxConcurrentQueries`    |      8 | 1–40  | 每个插件实例的在途查询数，含连接测试 |
| `maxQueriesPerConnection` |      2 | 1–8   | 每个连接的在途查询数                 |
| `maxPendingMutations`     |     32 | 1–128 | 配置操作队列容量，包含正在执行的操作 |

查询并发超限立即返回 `BUSY`，API 对应 HTTP 429。覆盖配置时保留原有 `namespace`；Bundle patch 的 `config` 按整体替换，不做深合并。

### 存储与隔离

连接写入 `dsh_database_default` Storage Domain v1，运行记录写入独立的 `dsh_database_default_operations` v1。`config.namespace` 可以隔离同一后端的数据；更换 Profile 名称本身不会隔离 home 级存储。

缺失可选字段时采用 schema 默认值：TLS 默认开启，未保存独立 policy 的记录按 Host 范围读取。显式 `tls:false` 保留，ID、revision 和密码引用不重写。

[卸载插件](usage.md#更新停用与卸载)会保留连接和凭据；删除连接会清理对应凭据。跨存储崩溃或清理失败可能留下未引用凭据。运行记录文件损坏会阻止插件激活；修复文件后可重新加载，初始化失败会释放已打开的存储。

### 接入方式

插件复用 DSH 已认证的 `/api` 通道及 Host/Origin 检查，按已保存授权分别验证可见性和执行权限。数据库驱动随运行时依赖安装、按需加载，不进入浏览器包；Oracle 使用纯 JavaScript Thin 模式。

插件不开放远程 MCP 监听端口。需要在代码中复用 `dsh-database/mcp` 时，见贡献指南中的 [MCP 工厂](../CONTRIBUTING.md#mcp-工厂)。

## 授权与记录机制

### 可信身份与额度

授权使用宿主提供的可信身份，沿实际执行作用域（scope）继承；模型传入的身份和复制的会话历史不能授予权限。缺少可信 AgentRegistry（宿主的 Agent 身份注册服务）时，会话授权模式启用失败，不会放宽为整个 Host。

额度按连接和可信顶层会话计算。inspect、缓存命中、query、原生工具和 PTC 共用额度，父子 Agent 也共用额度。计数窗口和重载行为见[调用额度](usage.md#调用额度)。

### 调用关联与诊断

记录关联 requestId、宿主 callId/rootCallId、可信会话与连接 revision，并展示安全错误码、缓存命中、取消请求和清理证据。Host 最终结果与 MCP/驱动过程归入同一条记录。驱动关闭和服务端终止分别显示，不把关闭 socket 表述为计算已停止。

记录的容量、保留期限和用户操作见[调用记录](usage.md#查看调用记录)。插件未实现 OTel（OpenTelemetry）外发；这不描述宿主的会话上传或遥测设置，数据流转见[查询数据如何使用](usage.md#查询数据如何使用)。

### 配置已写入但清理失败

配置已写入但清理失败时，API 会返回 `committed:true`、连接 ID 和最新安全列表，界面会同步名称与修订。不要用旧修订反复提交。凭据删除最多重试 3 次，仍失败会报错；进程崩溃或跨存储故障可能留下未引用凭据。
