import type { Engine } from '../../src/engines.js';

export const engineNames: Engine[] = [
  'mysql',
  'mariadb',
  'postgresql',
  'mongodb',
  'sqlserver',
  'oracle',
];
export interface Definition {
  image: string;
  port: number;
  memory: string;
  env: (password: string) => Record<string, string>;
  args?: string[];
}
// Version lines, never implicit :latest. Each run records the resolved immutable image ID.
export const definitions: Record<Engine, Definition> = {
  mysql: {
    image: 'mysql:8.4',
    port: 3306,
    memory: '768m',
    env: (password) => ({
      MYSQL_ROOT_PASSWORD: password,
      MYSQL_ROOT_HOST: '%',
      MYSQL_DATABASE: 'dsh_test',
      MYSQL_INITDB_SKIP_TZINFO: '1',
    }),
    args: ['--innodb-buffer-pool-size=64M'],
  },
  mariadb: {
    image: 'mariadb:11.4',
    port: 3306,
    memory: '512m',
    env: (password) => ({
      MARIADB_ROOT_PASSWORD: password,
      MARIADB_ROOT_HOST: '%',
      MARIADB_DATABASE: 'dsh_test',
      MARIADB_INITDB_SKIP_TZINFO: '1',
    }),
    args: ['--innodb-buffer-pool-size=64M'],
  },
  postgresql: {
    image: 'postgres:17-alpine',
    port: 5432,
    memory: '384m',
    env: (password) => ({ POSTGRES_PASSWORD: password, POSTGRES_DB: 'dsh_test' }),
  },
  mongodb: {
    image: 'mongo:8.0',
    port: 27017,
    memory: '512m',
    env: (password) => ({
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: password,
    }),
    args: ['--wiredTigerCacheSizeGB', '0.25'],
  },
  sqlserver: {
    image: 'mcr.microsoft.com/mssql/server:2022-CU27-ubuntu-22.04',
    port: 1433,
    memory: '3g',
    env: (password) => ({
      ACCEPT_EULA: 'Y',
      MSSQL_PID: 'Developer',
      MSSQL_SA_PASSWORD: password,
      MSSQL_MEMORY_LIMIT_MB: '2048',
    }),
  },
  oracle: {
    image: 'container-registry.oracle.com/database/free:23.9.0.0-lite',
    port: 1521,
    memory: '3g',
    env: (password) => ({ ORACLE_PWD: password }),
  },
};

export function selectEngines(value?: string): Engine[] {
  const selected = value === undefined ? engineNames : value.split(',');
  if (!selected.length || selected.some((name) => !engineNames.includes(name as Engine)))
    throw new Error(`Engines must be chosen from: ${engineNames.join(',')}`);
  return [...new Set(selected)] as Engine[];
}
