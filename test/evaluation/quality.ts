import assert from 'node:assert/strict';
import { queryResult, type QueryResult } from '../../src/schema.js';
import { inspectResult } from '../../src/inspect.js';

/** Only seed a freshly created, disposable PostgreSQL database. Never an existing user database. */
export const qualitySeed = [
  `CREATE TABLE public.eval_orders (id integer PRIMARY KEY, amount numeric(24,2), placed_at timestamptz)`,
  `CREATE TABLE public.eval_lines (id integer PRIMARY KEY, order_id integer REFERENCES public.eval_orders(id))`,
  `CREATE TABLE public.eval_refunds (id integer PRIMARY KEY, order_id integer REFERENCES public.eval_orders(id), amount numeric(24,2))`,
  `INSERT INTO public.eval_orders VALUES
    (1,100.10,'2025-03-31T23:30:00Z'), (2,100.10,'2025-04-01T00:30:00Z'),
    (3,90071992547409.91,'2025-03-01T00:00:00Z'), (4,0.02,'2025-02-28T23:30:00Z')`,
  `INSERT INTO public.eval_lines VALUES (1,1),(2,1),(3,2),(4,2),(5,2),(6,3),(7,4)`,
  `INSERT INTO public.eval_refunds VALUES (1,1,10.01),(2,1,20.02),(3,2,5.03)`,
  `GRANT SELECT ON public.eval_orders, public.eval_lines, public.eval_refunds TO dsh_reader`,
];

export const qualityCases = [
  {
    id: 'postgresql-join-fanout',
    engine: 'postgresql' as const,
    question:
      '先发现 eval_orders、eval_lines、eval_refunds 的结构。仅统计至少有一个明细行且 id <= 2 的订单，订单金额扣除全部退款后的合计是多少？两个订单金额相同，明细与退款均可能多行，不可重复计数，也不能按金额 DISTINCT。只输出保留两位小数的金额。',
    answer: '165.14',
    sql: `SELECT SUM(o.amount-COALESCE(r.amount,0))::text FROM public.eval_orders o LEFT JOIN (SELECT order_id,SUM(amount) AS amount FROM public.eval_refunds GROUP BY order_id) r ON r.order_id=o.id WHERE o.id<=2 AND EXISTS (SELECT 1 FROM public.eval_lines l WHERE l.order_id=o.id)`,
  },
  {
    id: 'postgresql-money-precision',
    engine: 'postgresql' as const,
    question:
      '发现 eval_orders 的结构后，求 id 为 3 和 4 的订单金额合计。必须保留数据库精确小数，不可转为浮点数或科学计数法。只输出保留两位小数的金额。',
    answer: '90071992547409.93',
    sql: `SELECT SUM(amount)::text FROM public.eval_orders WHERE id IN (3,4)`,
  },
  {
    id: 'postgresql-timezone-boundary',
    engine: 'postgresql' as const,
    question:
      '发现 eval_orders 的结构后，按 Asia/Shanghai 当地时间统计 2025 年 3 月的订单数。placed_at 是带时区的时间戳，月份边界使用左闭右开，不能依赖会话默认时区。只输出整数。',
    answer: '2',
    sql: `SELECT COUNT(*)::text FROM public.eval_orders WHERE placed_at >= TIMESTAMPTZ '2025-03-01 00:00:00+08' AND placed_at < TIMESTAMPTZ '2025-04-01 00:00:00+08'`,
  },
  {
    id: 'postgresql-truncated-total',
    engine: 'postgresql' as const,
    question:
      '发现 eval_orders 的结构后，先 SELECT id FROM public.eval_orders ORDER BY id 观察返回的截断标记，再取得完整订单数。不能把截断的两行当成全量。只输出完整订单数。',
    answer: '4',
    sql: `SELECT COUNT(*)::text FROM public.eval_orders`,
    required: 'truncation' as const,
  },
  {
    id: 'postgresql-error-recovery',
    engine: 'postgresql' as const,
    question:
      '旧查询 SELECT legacy_total FROM public.eval_orders WHERE id = 1 可能已经过期。先原样运行它，失败后发现实际结构，用现有订单金额列修正查询。不要编造缺失字段或尝试写操作。只输出 id=1 的订单金额，保留两位小数。',
    answer: '100.10',
    sql: `SELECT amount::text FROM public.eval_orders WHERE id=1`,
    required: 'recovery' as const,
  },
] as const;

export type QualityEvidence = {
  successfulCalls: number;
  successfulQueries: number;
  sawTruncation: boolean;
  recoveredAfterError: boolean;
};

/** Track validated query and discovery envelopes; metadata cannot substitute for business data. */
export function qualityEvidence() {
  const evidence: QualityEvidence = {
    successfulCalls: 0,
    successfulQueries: 0,
    sawTruncation: false,
    recoveredAfterError: false,
  };
  let expectedError = false;
  return {
    evidence,
    observe(sql: unknown, isError: boolean, value: unknown) {
      const statement =
        typeof sql === 'string' ? sql.trim().replace(/\s+/g, ' ').replace(/;$/, '') : '';
      if (isError) {
        if (/^SELECT legacy_total FROM public\.eval_orders WHERE id\s*=\s*1$/i.test(statement))
          expectedError = true;
        return;
      }
      const parsed = queryResult.safeParse(value);
      if (!parsed.success) {
        if (inspectResult.safeParse(value).success) evidence.successfulCalls++;
        return;
      }
      evidence.successfulCalls++;
      evidence.successfulQueries++;
      if (
        /^SELECT id FROM public\.eval_orders ORDER BY id$/i.test(statement) &&
        parsed.data.truncated
      )
        evidence.sawTruncation = true;
      if (
        expectedError &&
        !parsed.data.truncated &&
        parsed.data.rows.some((row) => row.some((cell) => String(cell) === '100.10'))
      )
        evidence.recoveredAfterError = true;
    },
  };
}

/** Correct text alone, an unsuccessful tool call, or an unrelated error is not sufficient evidence. */
export function gradeAnswer(
  task: { id?: string; answer: string; required?: 'truncation' | 'recovery' },
  answer: string,
  evidence: QualityEvidence,
): boolean {
  return (
    answer.trim() === task.answer &&
    (task.id === 'postgresql-large-schema'
      ? evidence.successfulCalls > 0
      : evidence.successfulQueries > 0) &&
    (task.required !== 'truncation' || evidence.sawTruncation) &&
    (task.required !== 'recovery' || evidence.recoveredAfterError)
  );
}

/** Enforced across all engines, repetitions, and variants; requests are charged before dispatch. */
export function requestBudget(value: string | undefined) {
  assert(
    value && /^[1-9]\d*$/.test(value),
    'Set DSH_DATABASE_EVAL_MAX_REQUESTS to an explicit positive integer request budget.',
  );
  const limit = Number(value);
  assert(Number.isSafeInteger(limit) && limit <= 10000, 'Request budget must be at most 10000.');
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    take() {
      if (used >= limit) throw new Error('MODEL_BUDGET_EXHAUSTED');
      used++;
    },
  };
}

/** Deterministic real-adapter checks. The caller owns a read-only QueryRunner with maxRows=2. */
export async function verifyQualityFixture(query: (sql: string) => Promise<QueryResult>) {
  for (const task of qualityCases) {
    const result = await query(task.sql);
    assert.equal(result.truncated, false, task.id);
    assert.equal(String(result.rows[0]?.[0]), task.answer, task.id);
  }
  const partial = await query('SELECT id FROM public.eval_orders ORDER BY id');
  assert.equal(partial.truncated, true);
  assert.equal(partial.rows.length, 2);
  const wrongJoin = await query(
    `SELECT SUM(o.amount-r.amount)::text FROM public.eval_orders o JOIN public.eval_lines l ON l.order_id=o.id LEFT JOIN public.eval_refunds r ON r.order_id=o.id WHERE o.id<=2`,
  );
  assert.notEqual(String(wrongJoin.rows[0]?.[0]), qualityCases[0].answer);
  await assert.rejects(query('SELECT legacy_total FROM public.eval_orders WHERE id=1'));
  assert.equal(String((await query(qualityCases[4].sql)).rows[0]?.[0]), '100.10');
}
