# 复现电商经营分析

[项目首页](../../../README.md) · [使用指南](../../usage.md#场景示例电商经营复盘)

这个可选示例使用与对话截图相同的合成数据：2026 年第一季度的 1,500 笔已支付订单、60 笔取消订单和 358 次退款。它不包含客户资料，也不需要真实业务数据库。

你将完成：准备示例库 → 创建只读账户 → 授权 Agent → 查询并分析 → 核对指标。

## 1. 准备独立示例库

需要 PostgreSQL 17、`psql` 客户端，以及可以创建示例库和角色的管理账户。Docker 不是必需条件；可使用独立的本地或测试 PostgreSQL。不要向业务库导入示例。

下载本目录的 [seed.sql](seed.sql) 和 [queries.sql](queries.sql)，在保存文件的目录打开终端。连接到测试 PostgreSQL；将主机、端口和管理账户替换为实际值，密码通过交互提示输入：

```sh
psql -h 127.0.0.1 -p 5432 -U YOUR_ADMIN -d postgres -W
```

在 `psql` 中先单独执行：

```sql
CREATE DATABASE dsh_database_example;
```

**只有看到 `CREATE DATABASE` 成功响应才继续。** 如果提示同名数据库已存在或任何错误，停止本次步骤，选择新的示例库名，并同步替换本文后续命令；不要连接已有同名库继续导入。

单独切换到刚创建的库：

```sql
\connect dsh_database_example
```

确认提示已连接到刚创建的示例库后，再执行：

```sql
\set ON_ERROR_STOP on
\i seed.sql
```

不要一次粘贴多个步骤；`psql` 交互模式报错后仍会返回提示符。`seed.sql` 在事务中建表并填充数据；遇到同名表会失败，不删除或覆盖已有数据。发生错误时先执行 `ROLLBACK;`，确认连接的是独立空库后再排查，不要通过删除未知表来重试。

## 2. 创建只读账户

继续在该示例库的 `psql` 会话中，先单独创建角色：

```sql
CREATE ROLE dsh_example_reader LOGIN;
```

**只有看到 `CREATE ROLE` 成功响应才继续。** 如果角色已存在或创建失败，停止并选择新的示例角色名，同步替换后续命令；不要修改已有同名角色的密码或权限。

单独执行以下命令，按提示输入两次新密码；完成前不要粘贴后续 SQL：

```sql
\password dsh_example_reader
```

密码设置成功后，再授予示例库的读取权限：

```sql
GRANT CONNECT ON DATABASE dsh_database_example TO dsh_example_reader;
GRANT USAGE ON SCHEMA public TO dsh_example_reader;
GRANT SELECT ON public.orders, public.refunds TO dsh_example_reader;
ALTER ROLE dsh_example_reader SET default_transaction_read_only = on;
```

为示例账户设置独立密码，不使用管理账户连接插件。只读权限由 `GRANT SELECT` 约束，默认只读事务是额外保护。

## 3. 连接并提问

按[使用指南](../../usage.md#管理连接)新建 PostgreSQL 连接：名称为「电商经营库（示例）」、数据库为 `dsh_database_example`、账户为 `dsh_example_reader`，地址、端口与密码使用刚才的测试环境值。

TLS 设置应与测试服务器一致；使用证书时按 [TLS 连接](../../usage.md#tls-连接)配置信任。本机只监听 loopback 的无 TLS 测试库可显式选择明文，不要把该选择照搬到远程数据库。

测试、保存，并仅授权当前示例会话，开启 Agent 访问。然后提问：

> 请用「电商经营库（示例）」复盘 2026 年 1—3 月经营情况：订单在增长，净收入为何增速放缓？先查看表结构，用只读查询按月和渠道汇总，正确扣除退款、排除取消订单。给我关键指标、收入趋势与渠道退款率图表，以及两条经营建议。

绘图需要宿主提供文件、执行工具和可用的绘图库；截图使用 Python / matplotlib。未配置绘图环境时，可以先核对表格。模型生成的措辞和图表样式可能不同，应以查询指标为准，不将经营建议视为已证实的因果关系。

## 4. 核对指标

用示例只读账户重新连接，在保存 SQL 文件的目录运行：

```sh
psql -h 127.0.0.1 -p 5432 -U dsh_example_reader -d dsh_database_example -W -v ON_ERROR_STOP=1 -f queries.sql
```

金额以人民币元计。按订单先汇总退款再关联订单，取消订单全部排除；退款率为退款金额除以成交额。

| 月份    | 已支付订单 |  成交额 |   退款 |  净收入 | 退款率 |
| ------- | ---------: | ------: | -----: | ------: | -----: |
| 2026-01 |        400 | 100,000 |  5,000 |  95,000 |  5.00% |
| 2026-02 |        500 | 125,000 |  6,250 | 118,750 |  5.00% |
| 2026-03 |        600 | 150,000 | 18,000 | 132,000 | 12.00% |

季度渠道退款率应为：付费广告 **12.75%**、老客复购 **3.69%**、自然搜索 **2.50%**。季度整体退款率为 **7.80%**，付费广告 3 月为 **19.05%**。

如果结果偏大，先检查是否直接关联了多条退款，导致同一订单金额被重复相加；如果订单数为 1,560，检查是否遗漏 `status = 'paid'`。

## 5. 结束示例

先在插件中关闭并删除示例连接，确认凭据清理完成。关闭占用示例库的会话后，以管理账户连接到 `postgres`，仅在确认下列库和角色由本示例独占时执行：

```sql
DROP DATABASE dsh_database_example;
DROP ROLE dsh_example_reader;
```

数据库仍有连接时删除会失败；先正常关闭这些连接，不强制终止其他工作。宿主中的示例对话和分析文件可按需单独删除，数据库清理不会删除它们。
