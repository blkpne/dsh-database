import type { ConnectionFields } from './schema.js';
import type { InspectInput, SqlStatement } from './inspect.js';

/** Only fixed catalog templates enter this privileged path. Names are bound values, never SQL. */
export function metadataStatements(
  config: ConnectionFields,
  input: InspectInput,
): { section: string; statement?: SqlStatement }[] {
  const engine = config.engine;
  const mysql = engine === 'mysql' || engine === 'mariadb';
  const pg = engine === 'postgresql';
  const oracle = engine === 'oracle';
  const q = (text: string, values: string[]): SqlStatement => {
    let n = 0;
    return {
      kind: 'sql',
      text: text.replace(/\?/g, () =>
        mysql ? '?' : pg ? `$${++n}` : oracle ? `:${++n}` : `@p${++n}`,
      ),
      values,
    };
  };
  const pattern = `%${(input.name ?? '').replace(/[!%_]/g, '!$&')}%`;
  const page = `OFFSET ${input.offset} ROWS FETCH NEXT ${input.limit + 1} ROWS ONLY`;
  if (input.action === 'namespaces') {
    const text = mysql
      ? `SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys') AND schema_name LIKE ? ESCAPE '!' ORDER BY schema_name LIMIT ${input.limit + 1} OFFSET ${input.offset}`
      : pg
        ? `SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE has_schema_privilege(oid,'USAGE') AND nspname NOT LIKE 'pg!_%' ESCAPE '!' AND nspname <> 'information_schema' AND nspname LIKE ? ESCAPE '!' ORDER BY nspname LIMIT ${input.limit + 1} OFFSET ${input.offset}`
        : oracle
          ? `SELECT DISTINCT owner AS name FROM all_objects WHERE object_type IN ('TABLE','VIEW') AND owner LIKE ? ESCAPE '!' ORDER BY owner ${page}`
          : `SELECT DISTINCT s.name AS name FROM sys.schemas s JOIN sys.objects o ON o.schema_id=s.schema_id WHERE o.type IN ('U','V') AND s.name NOT IN ('sys','INFORMATION_SCHEMA') AND s.name LIKE ? ESCAPE '!' ORDER BY s.name ${page}`;
    return [{ section: 'namespaces', statement: q(text, [pattern]) }];
  }
  if (input.action === 'search') {
    if (oracle)
      return [
        {
          section: 'objects',
          statement: q(
            `SELECT owner AS schema_name, object_name AS name, LOWER(object_type) AS type FROM all_objects WHERE object_type IN ('TABLE','VIEW') AND owner = COALESCE(NULLIF(?, ''), USER) AND object_name LIKE ? ESCAPE '!' AND (? IS NULL OR LOWER(object_type) = ?) ORDER BY owner, object_name, object_type ${page}`,
            [input.schema ?? '', pattern, input.type ?? '', input.type ?? ''],
          ),
        },
      ];
    const values = [
      mysql ? (input.catalog ?? input.schema ?? config.database) : (input.schema ?? ''),
      pattern,
      input.type ?? '',
      input.type === 'table' ? 'BASE TABLE' : input.type === 'view' ? 'VIEW' : '',
    ];
    const scope = mysql
      ? "(? = '' OR table_schema = ?)"
      : pg
        ? "table_schema = COALESCE(NULLIF(?, ''), current_schema())"
        : "table_schema = COALESCE(NULLIF(?, ''), SCHEMA_NAME())";
    if (mysql) values.unshift(values[0]!);
    const text = `SELECT table_catalog AS catalog, table_schema AS schema_name, table_name AS name, CASE WHEN table_type = 'BASE TABLE' THEN 'table' ELSE 'view' END AS type FROM information_schema.tables WHERE ${scope} AND table_schema NOT IN ('information_schema','pg_catalog','mysql','performance_schema','sys') AND table_name LIKE ? ESCAPE '!' AND (? = '' OR table_type = ?) ORDER BY table_schema, table_name ${mysql || pg ? `LIMIT ${input.limit + 1} OFFSET ${input.offset}` : page}`;
    return [{ section: 'objects', statement: q(text, values) }];
  }
  const name = input.name!;
  const schema = input.schema ?? (mysql ? (input.catalog ?? config.database) : '');
  const requests: { section: string; statement?: SqlStatement }[] = [];
  const add = (section: string, text: string, values = [schema, name]) =>
    requests.push({ section, statement: q(text, values) });
  if (mysql) {
    add(
      'columns',
      `SELECT column_name AS name, column_type AS data_type, is_nullable, column_default AS default_value, column_comment AS comment FROM information_schema.columns WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? ORDER BY ordinal_position`,
    );
    add(
      'keys',
      `SELECT constraint_name AS name, column_name, ordinal_position, referenced_table_schema AS target_schema, referenced_table_name AS target_table, referenced_column_name AS target_column FROM information_schema.key_column_usage WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? ORDER BY constraint_name, ordinal_position`,
    );
    add(
      'indexes',
      `SELECT index_name AS name, column_name, seq_in_index AS position, non_unique, index_type FROM information_schema.statistics WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? ORDER BY index_name, seq_in_index`,
    );
    add(
      'comments',
      `SELECT table_comment AS comment FROM information_schema.tables WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ?`,
    );
  } else if (pg) {
    add(
      'columns',
      `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type, NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value, pg_catalog.col_description(c.oid,a.attnum) AS comment, has_table_privilege(c.oid,'SELECT') AS __table_select FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=COALESCE(NULLIF(?, ''),current_schema()) AND c.relname=? AND a.attnum>0 AND NOT a.attisdropped AND has_schema_privilege(n.oid,'USAGE') AND has_column_privilege(c.oid,a.attnum,'SELECT') ORDER BY a.attnum`,
    );
    add(
      'keys',
      `SELECT k.conname AS name, k.contype AS type, pg_catalog.pg_get_constraintdef(k.oid) AS definition FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=COALESCE(NULLIF(?, ''),current_schema()) AND c.relname=? AND k.contype IN ('p','f','u') AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT') ORDER BY k.conname`,
    );
    add(
      'indexes',
      `SELECT i.relname AS name, pg_catalog.pg_get_indexdef(x.indexrelid) AS definition, x.indisunique AS is_unique, x.indisprimary AS is_primary FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class c ON c.oid=x.indrelid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=COALESCE(NULLIF(?, ''),current_schema()) AND c.relname=? AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT') ORDER BY i.relname`,
    );
    add(
      'comments',
      `SELECT pg_catalog.obj_description(c.oid,'pg_class') AS comment FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=COALESCE(NULLIF(?, ''),current_schema()) AND c.relname=? AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT')`,
    );
  } else if (oracle) {
    add(
      'columns',
      `SELECT c.column_name AS name, c.data_type, c.data_length, c.data_precision, c.data_scale, c.nullable, c.data_default AS default_value, m.comments AS "comment" FROM all_tab_columns c LEFT JOIN all_col_comments m ON m.owner=c.owner AND m.table_name=c.table_name AND m.column_name=c.column_name WHERE c.owner=COALESCE(?,USER) AND c.table_name=? ORDER BY c.column_id`,
    );
    // Bound catalog optimization work in these two fixed Oracle queries. Cold and warm
    // comparisons cover equivalent results, composite keys and inaccessible tables;
    // this public hint changes no permissions, result bounds or execution deadline.
    add(
      'keys',
      `SELECT /*+ NO_QUERY_TRANSFORMATION */ c.constraint_name AS name, c.constraint_type AS type, col.column_name, col.position FROM all_constraints c JOIN all_cons_columns col ON col.owner=c.owner AND col.constraint_name=c.constraint_name AND col.table_name=c.table_name WHERE c.owner=COALESCE(?,USER) AND c.table_name=? AND c.constraint_type IN ('P','U') ORDER BY c.constraint_name,col.position`,
    );
    add(
      'foreignKeys',
      `SELECT /*+ NO_QUERY_TRANSFORMATION */ c.constraint_name AS name, col.column_name, col.position, c.r_owner AS target_schema, c.r_constraint_name AS target_constraint, r.table_name AS target_table, rc.column_name AS target_column FROM all_constraints c JOIN all_cons_columns col ON col.owner=c.owner AND col.constraint_name=c.constraint_name AND col.table_name=c.table_name LEFT JOIN all_constraints r ON r.owner=c.r_owner AND r.constraint_name=c.r_constraint_name LEFT JOIN all_cons_columns rc ON rc.owner=r.owner AND rc.constraint_name=r.constraint_name AND rc.table_name=r.table_name AND rc.position=col.position WHERE c.owner=COALESCE(?,USER) AND c.table_name=? AND c.constraint_type='R' ORDER BY c.constraint_name,col.position`,
    );
    add(
      'indexes',
      `SELECT i.index_name AS name, i.uniqueness, c.column_name, c.column_position FROM all_indexes i JOIN all_ind_columns c ON c.index_owner=i.owner AND c.index_name=i.index_name WHERE i.table_owner=COALESCE(?,USER) AND i.table_name=? ORDER BY i.index_name,c.column_position`,
    );
    add(
      'comments',
      `SELECT comments AS "comment" FROM all_tab_comments WHERE owner=COALESCE(?,USER) AND table_name=?`,
    );
  } else {
    add(
      'columns',
      `SELECT c.name AS name, t.name AS data_type, c.max_length, c.precision, c.scale, c.is_nullable AS nullable, d.definition AS default_value, CAST(p.value AS nvarchar(4000)) AS comment FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.types t ON t.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints d ON d.object_id=c.default_object_id LEFT JOIN sys.extended_properties p ON p.major_id=c.object_id AND p.minor_id=c.column_id AND p.name='MS_Description' WHERE s.name=COALESCE(NULLIF(?,''),SCHEMA_NAME()) AND o.name=? ORDER BY c.column_id`,
    );
    add(
      'keys',
      `SELECT fk.name AS name, c.name AS column_name, rs.name AS target_schema, ro.name AS target_table, rc.name AS target_column, fc.constraint_column_id AS position FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=fk.object_id JOIN sys.objects o ON o.object_id=fc.parent_object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.columns c ON c.object_id=o.object_id AND c.column_id=fc.parent_column_id JOIN sys.objects ro ON ro.object_id=fc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=ro.schema_id JOIN sys.columns rc ON rc.object_id=ro.object_id AND rc.column_id=fc.referenced_column_id WHERE s.name=COALESCE(NULLIF(?,''),SCHEMA_NAME()) AND o.name=? ORDER BY fk.name,fc.constraint_column_id`,
    );
    add(
      'indexes',
      `SELECT i.name AS name, i.is_unique, i.is_primary_key, c.name AS column_name, ic.key_ordinal AS position, ic.is_included_column FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE s.name=COALESCE(NULLIF(?,''),SCHEMA_NAME()) AND o.name=? ORDER BY i.name,ic.key_ordinal`,
    );
    add(
      'comments',
      `SELECT CAST(p.value AS nvarchar(4000)) AS comment FROM sys.extended_properties p JOIN sys.objects o ON o.object_id=p.major_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE p.minor_id=0 AND p.name='MS_Description' AND s.name=COALESCE(NULLIF(?,''),SCHEMA_NAME()) AND o.name=?`,
    );
  }
  return requests;
}
