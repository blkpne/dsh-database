import type { MetadataRequest, SqlStatement } from '../inspect.js';
import { MAX_METADATA_ROWS } from '../inspect.js';
import { ResultCollector } from '../result.js';
import type { QueryResult } from '../schema.js';

type Row = QueryResult['rows'][number];
export type CatalogRead = (
  statement: SqlStatement,
  accept: (row: unknown[]) => boolean,
) => Promise<void>;
const BATCH_SIZE = 32;
const constraintsSql =
  'SELECT owner,constraint_name,constraint_type,table_name,r_owner,r_constraint_name FROM all_constraints WHERE owner=COALESCE(:1,USER) AND table_name=:2 AND constraint_type IN (:3,:4) ORDER BY constraint_name';
const key = (...parts: unknown[]) => JSON.stringify(parts);
const columns = {
  keys: ['NAME', 'TYPE', 'COLUMN_NAME', 'POSITION'],
  foreignKeys: [
    'NAME',
    'COLUMN_NAME',
    'POSITION',
    'TARGET_SCHEMA',
    'TARGET_CONSTRAINT',
    'TARGET_TABLE',
    'TARGET_COLUMN',
  ],
};
class IncompleteCatalog extends Error {}

/** Internal fixed catalog operations, all on the adapter's existing read-only transaction. */
export async function oracleConstraints(
  request: MetadataRequest,
  read: CatalogRead,
  result: ResultCollector,
  signal: AbortSignal,
): Promise<void> {
  if (
    request.input.action !== 'describe' ||
    !request.input.name ||
    (request.section !== 'keys' && request.section !== 'foreignKeys')
  )
    throw new Error('Unsupported Oracle metadata request');
  const foreign = request.section === 'foreignKeys';
  result.fields(columns[request.section]);
  // Every retained intermediate row shares this budget, including targets from all batches.
  const budget = new ResultCollector(MAX_METADATA_ROWS * 4);
  budget.fields([]);
  const query = async (text: string, values: string[]): Promise<Row[]> => {
    signal.throwIfAborted();
    const rows: Row[] = [];
    await read({ kind: 'sql', text, values }, (row) => {
      signal.throwIfAborted();
      if (rows.length >= MAX_METADATA_ROWS) {
        budget.truncate('row_limit');
        return false;
      }
      if (!budget.row(row)) return false;
      rows.push(budget.rows[budget.rows.length - 1]!);
      return true;
    });
    signal.throwIfAborted();
    if (budget.truncated) throw new IncompleteCatalog();
    return rows;
  };
  const batches = async (
    owner: string,
    names: string[],
    projection: string,
    view: 'all_constraints' | 'all_cons_columns',
    table?: string,
  ): Promise<Row[]> => {
    const rows: Row[] = [];
    for (let offset = 0; offset < names.length; offset += BATCH_SIZE) {
      signal.throwIfAborted();
      const chunk = names.slice(offset, offset + BATCH_SIZE);
      const values = [owner, ...(table === undefined ? [] : [table]), ...chunk];
      // Empty Oracle strings bind as NULL and cannot match a constraint name.
      while (values.length < 1 + (table === undefined ? 0 : 1) + BATCH_SIZE) values.push('');
      const start = table === undefined ? 2 : 3;
      const binds = Array.from({ length: BATCH_SIZE }, (_, i) => `:${start + i}`).join(',');
      rows.push(
        ...(await query(
          `SELECT ${projection} FROM ${view} WHERE owner=:1${table === undefined ? '' : ' AND table_name=:2'} AND constraint_name IN (${binds}) ORDER BY constraint_name${view === 'all_cons_columns' ? ',position' : ''}`,
          values,
        )),
      );
    }
    return rows;
  };
  try {
    const source = await query(constraintsSql, [
      request.input.schema ?? '',
      request.input.name,
      foreign ? 'R' : 'P',
      foreign ? 'R' : 'U',
    ]);
    if (!source.length) return;
    const owner = String(source[0]![0]);
    const sourceColumns = await batches(
      owner,
      source.map((row) => String(row[1])),
      'owner,constraint_name,table_name,column_name,position',
      'all_cons_columns',
      request.input.name,
    );
    const byConstraint = new Map<string, Row[]>();
    for (const row of sourceColumns) {
      signal.throwIfAborted();
      const id = key(row[0], row[1], row[2]);
      const group = byConstraint.get(id) ?? [];
      group.push(row);
      byConstraint.set(id, group);
    }
    const targets = new Map<string, Row>();
    const targetColumns = new Map<string, Row>();
    if (foreign) {
      const owners = new Map<string, Set<string>>();
      for (const row of source) {
        signal.throwIfAborted();
        if (row[4] === null || row[5] === null) continue;
        const names = owners.get(String(row[4])) ?? new Set<string>();
        names.add(String(row[5]));
        owners.set(String(row[4]), names);
      }
      for (const [targetOwner, names] of owners) {
        // Read only authorized target columns, then validate against the constraint
        // view before exposing any target detail. Reuse the source SQL shape rather
        // than incurring another cold dictionary compilation for name lookups.
        const targetRows = await batches(
          targetOwner,
          [...names],
          'owner,constraint_name,table_name,column_name,position',
          'all_cons_columns',
        );
        const withColumns = new Set(targetRows.map((row) => String(row[1])));
        const missing = [...names].filter((name) => !withColumns.has(name));
        // ALL_CONSTRAINTS may expose a target even when its columns are absent.
        // Preserve the original LEFT JOIN's visible table / null column result.
        for (const row of await batches(
          targetOwner,
          missing,
          'owner,constraint_name,table_name',
          'all_constraints',
        ))
          targets.set(key(row[0], row[1]), row);
        const tables = new Set(targetRows.map((row) => String(row[2])));
        for (const table of tables) {
          const visible = await query(constraintsSql, [targetOwner, table, 'P', 'U']);
          for (const row of visible) {
            signal.throwIfAborted();
            if (names.has(String(row[1])))
              targets.set(key(row[0], row[1]), [row[0]!, row[1]!, row[3]!]);
          }
        }
        for (const row of targetRows) {
          signal.throwIfAborted();
          targetColumns.set(key(row[0], row[1], row[2], Number(row[4])), row);
        }
      }
    }
    // No partial component is presented as a complete key or a hidden target.
    for (const constraint of source) {
      signal.throwIfAborted();
      const members = byConstraint.get(key(constraint[0], constraint[1], constraint[3])) ?? [];
      members.sort((a, b) => Number(a[4]) - Number(b[4]));
      for (const column of members) {
        signal.throwIfAborted();
        const target = targets.get(key(constraint[4], constraint[5]));
        const targetColumn =
          target && targetColumns.get(key(target[0], target[1], target[2], Number(column[4])));
        if (
          !result.row(
            foreign
              ? [
                  constraint[1],
                  column[3],
                  column[4],
                  constraint[4],
                  constraint[5],
                  target?.[2] ?? null,
                  targetColumn?.[3] ?? null,
                ]
              : [constraint[1], constraint[2], column[3], column[4]],
          )
        )
          return;
      }
    }
  } catch (error) {
    if (!(error instanceof IncompleteCatalog)) throw error;
    result.truncate(budget.truncationReason ?? 'row_limit');
  }
}
