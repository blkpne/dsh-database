import { DatabaseError } from './schema.js';
import type { Engine } from './engines.js';
import transactSql from 'node-sql-parser/build/transactsql.js';

const tsqlParser = new transactSql.Parser();
const sqlServerLocks = new Set([
  'TABLOCKX',
  'XLOCK',
  'UPDLOCK',
  'HOLDLOCK',
  'TABLOCK',
  'PAGLOCK',
  'ROWLOCK',
  'READCOMMITTEDLOCK',
  'REPEATABLEREAD',
  'SERIALIZABLE',
]);
// T-SQL statement keywords must not be mistaken for implicit aliases by the parser.
// FETCH is also a SELECT pagination clause; the AST check rejects cursor FETCH batches.
const sqlServerCommands = new Set([
  'CHECKPOINT',
  'KILL',
  'REVERT',
  'RETURN',
  'BREAK',
  'CONTINUE',
  'GOTO',
  'IF',
  'WHILE',
  'DENY',
  'OPEN',
  'CLOSE',
  'RAISERROR',
  'THROW',
  'READTEXT',
  'WRITETEXT',
  'UPDATETEXT',
  'SEND',
  'RECEIVE',
  'SAVE',
  'SETUSER',
  'DISK',
  'DUMP',
  'EXIT',
]);

/** Conservative lexer, followed by a real READ ONLY transaction; not a general SQL parser. */
function validateMysqlSql(input: string): string {
  const fail = () => {
    throw new DatabaseError(
      'READ_ONLY_VIOLATION',
      '只允许单条只读 SQL：SELECT、WITH、SHOW、DESCRIBE 或 EXPLAIN SELECT。',
    );
  };
  if (typeof input !== 'string' || input.length > 32768 || !input.trim()) fail();
  // No ambiguous backslash escaping, executable comments, optimizer hints, user variables or assignments.
  if (/[\\\0]/.test(input)) fail();
  const tokens: string[] = [];
  let i = 0;
  let ended = false;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (input.startsWith('--', i) && /\s/.test(input[i + 2] ?? ' ')) {
      const end = input.slice(i).search(/[\r\n]/);
      if (end < 0) break;
      i += end + 1;
      continue;
    }
    if (c === '#') {
      const end = input.slice(i).search(/[\r\n]/);
      if (end < 0) break;
      i += end + 1;
      continue;
    }
    if (input.startsWith('/*', i)) {
      if (/[!+]/.test(input[i + 2] ?? '') || /^M!/i.test(input.slice(i + 2, i + 4))) fail();
      const end = input.indexOf('*/', i + 2);
      if (end < 0 || input.slice(i + 2, end).includes('/*')) fail();
      i = end + 2;
      continue;
    }
    if (ended) fail();
    if (c === ';') {
      ended = true;
      i++;
      continue;
    }
    if (c === '@' || input.startsWith(':=', i)) fail();
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i + 1;
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === quote) {
          if (input[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) fail();
      if (
        quote !== "'" &&
        ['LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'BENCHMARK'].includes(
          input.slice(start, i - 1).toUpperCase(),
        )
      )
        fail();
      tokens.push('QUOTED');
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(input.slice(i));
    if (word) {
      tokens.push(word[0].toUpperCase());
      i += word[0].length;
    } else i++;
  }
  const first = tokens[0];
  if (!first || !['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)) fail();
  const forbidden = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'REPLACE',
    'MERGE',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'CALL',
    'EXECUTE',
    'PREPARE',
    'DEALLOCATE',
    'HANDLER',
    'LOAD',
    'LOAD_FILE',
    'INTO',
    'OUTFILE',
    'DUMPFILE',
    'LOCK',
    'UNLOCK',
    'FOR',
    'PROCEDURE',
    'GET_LOCK',
    'RELEASE_LOCK',
    'RELEASE_ALL_LOCKS',
    'SET',
    'COMMIT',
    'ROLLBACK',
    'START',
    'TRANSACTION',
    'BENCHMARK',
  ]);
  if (first === 'SHOW') {
    const rest = tokens.slice(1).join(' ');
    if (
      !/^(DATABASES|SCHEMAS|TABLES|FULL TABLES|COLUMNS|FULL COLUMNS|FIELDS|INDEX|INDEXES|KEYS|CREATE TABLE)( |$)/.test(
        rest,
      )
    )
      fail();
    if (tokens.slice(1).some((t) => forbidden.has(t) && t !== 'CREATE')) fail();
  } else {
    if (tokens.some((t) => forbidden.has(t))) fail();
    if (first === 'WITH' && !tokens.includes('SELECT')) fail();
    if (first === 'EXPLAIN' && !['SELECT', 'WITH'].includes(tokens[1] ?? '')) fail();
  }
  return input.trim();
}

/** Each SQL dialect has its own lexical boundary; unsupported quoting is rejected. */
export function validateReadOnlySql(input: string, engine: Engine = 'mysql'): string {
  if (engine === 'mysql' || engine === 'mariadb') return validateMysqlSql(input);
  const fail = (): never => {
    throw new DatabaseError(
      'READ_ONLY_VIOLATION',
      '只允许当前数据库方言的单条 SELECT 或 WITH 只读查询。',
    );
  };
  if (
    engine === 'mongodb' ||
    typeof input !== 'string' ||
    !input.trim() ||
    input.length > 32768 ||
    /[\\\0]/.test(input)
  )
    fail();
  const tokens: string[] = [];
  const dangerous = /^(PG_|LO_|DBMS_|UTL_|XP_|SP_)/;
  const quotedIdentifiers: { start: number; end: number }[] = [];
  const calls = new Set([
    'NEXTVAL',
    'SETVAL',
    'SET_CONFIG',
    'DBLINK',
    'OPENQUERY',
    'OPENROWSET',
    'OPENDATASOURCE',
  ]);
  let i = 0,
    ended = false;
  let terminator: number | undefined;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (input.startsWith('--', i)) {
      const end = input.slice(i).search(/[\r\n]/);
      if (end < 0) break;
      i += end + 1;
      continue;
    }
    if (input.startsWith('/*', i)) {
      const end = input.indexOf('*/', i + 2);
      if (end < 0 || /[!+]/.test(input[i + 2] ?? '') || input.slice(i + 2, end).includes('/*'))
        fail();
      i = end + 2;
      continue;
    }
    if (ended) fail();
    if (c === ';') {
      ended = true;
      terminator = i;
      i++;
      continue;
    }
    if (c === '$' || c === '@' || c === '`' || c === '#' || input.startsWith(':=', i)) fail();
    if (c === "'" || c === '"' || c === '[') {
      if (c === '[' && engine !== 'sqlserver') fail();
      const quote = c === '[' ? ']' : c;
      const start = ++i;
      let closed = false;
      while (i < input.length) {
        if (input[i] === quote) {
          if (input[i + 1] === quote) {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) fail();
      const name = input
        .slice(start, i - 1)
        .trim()
        .toUpperCase();
      if (c !== "'" && (dangerous.test(name) || calls.has(name))) fail();
      if (c !== "'" && engine === 'sqlserver') {
        if (sqlServerLocks.has(name)) fail();
        quotedIdentifiers.push({ start: start - 1, end: i });
      }
      tokens.push('QUOTED');
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(input.slice(i));
    if (word) {
      if (/^(N?Q)$/i.test(word[0]) && input[i + word[0].length] === "'") fail();
      tokens.push(word[0].toUpperCase());
      i += word[0].length;
    } else i++;
  }
  const forbidden = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'REPLACE',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'CALL',
    'EXEC',
    'EXECUTE',
    'PREPARE',
    'DEALLOCATE',
    'COPY',
    'INTO',
    'FOR',
    'LOCK',
    'SET',
    'RESET',
    'COMMIT',
    'ROLLBACK',
    'BEGIN',
    'START',
    'TRANSACTION',
    'DO',
    'DECLARE',
    'USE',
    'WAITFOR',
    'PRINT',
    'DBCC',
    'BACKUP',
    'RESTORE',
    'BULK',
    'RECONFIGURE',
    'SHUTDOWN',
    'VACUUM',
    'ANALYZE',
    'LISTEN',
    'NOTIFY',
    'UNLISTEN',
    'DISCARD',
    'SECURITY',
    'NEXTVAL',
  ]);
  if (
    !['SELECT', 'WITH', ...(engine === 'postgresql' ? ['EXPLAIN'] : [])].includes(tokens[0] ?? '')
  )
    fail();
  if (tokens.some((t) => forbidden.has(t) || dangerous.test(t) || calls.has(t))) fail();
  if (tokens[0] === 'WITH' && !tokens.includes('SELECT')) fail();
  if (tokens[0] === 'EXPLAIN' && !['SELECT', 'WITH'].includes(tokens[1] ?? '')) fail();
  if (engine === 'sqlserver') {
    if (tokens.some((token) => sqlServerLocks.has(token) || sqlServerCommands.has(token))) fail();
    // The lexer validates escaping. Normalize quoted identifiers only for parsing:
    // this parser does not support T-SQL's escaped closing bracket (]]).
    // Execute the original SQL, never the normalized text or a re-serialized AST.
    let syntax = input;
    for (const { start, end } of quotedIdentifiers.reverse())
      syntax = syntax.slice(0, start) + '[dsh_identifier]' + syntax.slice(end);
    try {
      const ast = tsqlParser.astify(syntax, { database: 'TransactSQL' });
      const statements = Array.isArray(ast) ? ast : [ast];
      if (statements.length !== 1 || statements[0]?.type !== 'select') fail();
    } catch {
      fail();
    }
  }
  return input.slice(0, terminator).trim();
}
