import { DatabaseSync } from 'node:sqlite';
import { connectionInput } from '../../src/schema.js';
import { QueryRunner } from '../../src/query.js';
import { createDatabaseServer } from '../../src/mcp.js';

/** Synthetic, immutable evaluation data. SQLite is a test executor, never a shipped adapter. */
export function evaluationFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, month TEXT, status TEXT, amount_cents INTEGER);
    CREATE TABLE refunds (order_id INTEGER, amount_cents INTEGER);
    INSERT INTO customers VALUES (1,'Aster','East'),(2,'Birch','West'),(3,'Cedar','East'),(4,'Dune','North'),(5,'Elm','West');
    INSERT INTO orders VALUES
      (101,1,'2025-01','paid',10000),(102,1,'2025-02','paid',20000),
      (103,2,'2025-01','paid',15000),(104,2,'2025-02','canceled',90000),
      (105,3,'2025-02','paid',30000),(106,3,'2025-03','paid',5000),
      (107,4,'2025-01','paid',8000),(108,4,'2025-03','paid',12000),
      (109,2,'2025-03','paid',25000),(110,5,'2025-02','pending',7000),
      (111,1,'2025-03','paid',5000);
    INSERT INTO refunds VALUES (103,5000),(105,10000),(109,2500),(109,2500),(107,8000);
    PRAGMA query_only = ON;
  `);
  const tables = ['customers', 'orders', 'refunds'];
  const runner = new QueryRunner(
    connectionInput.parse({
      name: 'Frozen commerce fixture',
      host: 'fixture.invalid',
      user: 'fixture',
      maxRows: 3,
    }),
    async () => '',
    async () =>
      async (input, { result, signal }) => {
        signal.throwIfAborted();
        if (typeof input !== 'string') throw new Error('SQL fixture only');
        let sql = input;
        if (/^SHOW TABLES$/i.test(sql))
          sql = "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name";
        const table = /^DESCRIBE ([a-z]+)$/i.exec(sql)?.[1];
        if (table && tables.includes(table))
          sql = `SELECT name, type FROM pragma_table_info('${table}')`;
        const statement = db.prepare(sql);
        result.fields(statement.columns().map((column) => column.name));
        statement.setReturnArrays(true);
        for (const row of statement.iterate()) {
          if (!Array.isArray(row)) throw new Error('Expected array row');
          if (!result.row(row)) break;
        }
      },
  );
  const server = createDatabaseServer(
    'Frozen synthetic 2025-Q1 commerce data. Discover using SHOW TABLES and DESCRIBE table. SELECT/CTE queries and joins supported. Money is integer cents. At most 3 rows per response: inspect truncated and use ordered LIMIT/OFFSET or aggregate. Net paid revenue subtracts ALL refunds per order; canceled and pending orders contribute zero. No real database connection.',
    (sql, signal) => runner.query(sql, signal),
  );
  return {
    server,
    async close() {
      await server.close();
      await runner.close();
      db.close();
    },
  };
}
