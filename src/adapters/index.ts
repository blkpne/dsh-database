import type { Engine } from '../engines.js';
import type { Adapter } from './types.js';

/** Exhaustive lazy registry: adding an engine requires a driver binding at compile time. */
const adapters: Record<Engine, () => Promise<{ execute: Adapter }>> = {
  mysql: () => import('./mysql.js'),
  mariadb: () => import('./mysql.js'),
  postgresql: () => import('./postgresql.js'),
  sqlserver: () => import('./sqlserver.js'),
  oracle: () => import('./oracle.js'),
  mongodb: () => import('./mongodb.js'),
};

export const loadAdapter = async (engine: Engine): Promise<Adapter> =>
  (await adapters[engine]()).execute;
