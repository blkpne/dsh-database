/** Browser-safe connection metadata, shared by configuration and the existing form. */
export const engines = {
  mysql: { label: 'MySQL', port: 3306, databaseRequired: false },
  mariadb: { label: 'MariaDB', port: 3306, databaseRequired: false },
  postgresql: { label: 'PostgreSQL', port: 5432, databaseRequired: true },
  sqlserver: { label: 'SQL Server', port: 1433, databaseRequired: false },
  oracle: { label: 'Oracle', port: 1521, databaseRequired: true },
  mongodb: { label: 'MongoDB', port: 27017, databaseRequired: true },
} as const;
export type Engine = keyof typeof engines;

export const discovery: Record<Engine, string> = {
  mysql: 'SHOW DATABASES; SHOW TABLES; DESCRIBE table_name (one statement per call).',
  mariadb: 'SHOW DATABASES; SHOW TABLES; DESCRIBE table_name (one statement per call).',
  postgresql:
    'SELECT table_schema, table_name FROM information_schema.tables; inspect information_schema.columns. Use schema.table within the configured database.',
  sqlserver:
    'SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES; inspect INFORMATION_SCHEMA.COLUMNS. Use schema.table. Requires a database-side read-only account. CAST decimal/numeric/money columns AS varchar(100) to preserve precision.',
  oracle:
    'SELECT owner, table_name FROM all_tables; inspect all_tab_columns. Use owner.table and Oracle SQL; SELECT constants FROM DUAL.',
  mongodb:
    'Use operation listCollections, then find, aggregate or count with collection. filter/projection/sort use JSON objects; pipeline is a JSON array. Extended JSON v2 values such as {"$oid":"..."} are supported. No shell code, commands, writes or server-side JavaScript.',
};

export const probes: Record<Exclude<Engine, 'mongodb'>, string> = {
  mysql: 'SELECT VERSION() AS version, DATABASE() AS current_database',
  mariadb: 'SELECT VERSION() AS version, DATABASE() AS current_database',
  postgresql:
    "SELECT current_setting('server_version') AS version, current_database() AS current_database",
  sqlserver:
    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(128)) AS version, DB_NAME() AS current_database",
  oracle:
    "SELECT 'Oracle' AS version, SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS current_database FROM DUAL",
};
