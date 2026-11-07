import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeAnswer,
  qualityCases,
  qualityEvidence,
  qualitySeed,
  requestBudget,
} from './evaluation/quality.js';
import { validateReadOnlySql } from '../src/sql.js';
import { queryResult } from '../src/schema.js';

const result = (rows: unknown[][], truncated = false) =>
  queryResult.parse({
    columns: ['value'],
    rows,
    rowCount: rows.length,
    truncated,
    durationMs: 0,
    readOnly: true,
  });

test('quality answer keys are unique, exact, and use PostgreSQL read-only SQL', () => {
  assert.equal(qualityCases.length, 5);
  assert.equal(new Set(qualityCases.map((task) => task.id)).size, 5);
  for (const task of qualityCases)
    assert.doesNotThrow(() => validateReadOnlySql(task.sql, 'postgresql'));
  assert.equal(qualityCases[1].answer, '90071992547409.93');
  assert(qualitySeed.every((sql) => !/DROP|DELETE|TRUNCATE/i.test(sql)));
});

test('join-fanout answer matches independently summed fixture amounts in integer cents', () => {
  const cents = (value: string) => BigInt(value.replace('.', ''));
  const orders = qualitySeed.find((sql) => sql.startsWith('INSERT INTO public.eval_orders'))!;
  const refunds = qualitySeed.find((sql) => sql.startsWith('INSERT INTO public.eval_refunds'))!;
  const gross = [...orders.matchAll(/\((\d+),([0-9]+\.[0-9]{2}),/g)]
    .filter((match) => Number(match[1]) <= 2)
    .reduce((sum, match) => sum + cents(match[2]!), 0n);
  const refunded = [...refunds.matchAll(/\(\d+,(\d+),([0-9]+\.[0-9]{2})\)/g)]
    .filter((match) => Number(match[1]) <= 2)
    .reduce((sum, match) => sum + cents(match[2]!), 0n);
  assert.equal(gross, 20020n);
  assert.equal(refunded, 3506n);
  const net = gross - refunded;
  assert.equal(qualityCases[0].answer, `${net / 100n}.${String(net % 100n).padStart(2, '0')}`);
});

test('matching text without successful query evidence never passes', () => {
  const observed = qualityEvidence();
  const task = qualityCases[0];
  observed.observe(undefined, false, { tables: [] });
  observed.observe('SELECT missing', true, undefined);
  assert.equal(gradeAnswer(task, task.answer, observed.evidence), false);
  observed.observe(task.sql, false, result([[task.answer]]));
  assert.equal(gradeAnswer(task, task.answer, observed.evidence), true);
  assert.equal(gradeAnswer(task, `${task.answer} 元`, observed.evidence), false);
  assert.equal(gradeAnswer(qualityCases[1], '90071992547409.94', observed.evidence), false);
});

test('truncation case needs actual requested partial-result evidence before complete answer', () => {
  const observed = qualityEvidence();
  const task = qualityCases[3];
  observed.observe(task.sql, false, result([['4']]));
  assert.equal(gradeAnswer(task, '4', observed.evidence), false);
  observed.observe('SELECT id FROM unrelated ORDER BY id', false, result([[1], [2]], true));
  assert.equal(gradeAnswer(task, '4', observed.evidence), false);
  observed.observe(
    'SELECT id FROM public.eval_orders ORDER BY id',
    false,
    result([[1], [2]], true),
  );
  assert.equal(gradeAnswer(task, '2', observed.evidence), false);
  assert.equal(gradeAnswer(task, '4', observed.evidence), true);
});

test('recovery requires the obsolete query error followed by a successful untruncated amount result', () => {
  const observed = qualityEvidence();
  const task = qualityCases[4];
  observed.observe(task.sql, false, result([['100.10']]));
  observed.observe('SELECT unrelated', true, undefined);
  assert.equal(gradeAnswer(task, task.answer, observed.evidence), false);
  observed.observe('SELECT legacy_total FROM public.eval_orders WHERE id = 1', true, undefined);
  assert.equal(gradeAnswer(task, task.answer, observed.evidence), false);
  observed.observe(task.sql, false, result([['100.10']], true));
  assert.equal(gradeAnswer(task, task.answer, observed.evidence), false);
  observed.observe(task.sql, false, result([['100.10']]));
  assert.equal(gradeAnswer(task, task.answer, observed.evidence), true);
});

test('online request budget is explicit and stops before dispatch beyond its limit', () => {
  for (const invalid of [undefined, '', '0', '-1', '1.5', 'Infinity', '10001', '1e3'])
    assert.throws(() => requestBudget(invalid));
  const budget = requestBudget('2');
  budget.take();
  budget.take();
  assert.equal(budget.used, 2);
  assert.throws(() => budget.take(), /MODEL_BUDGET_EXHAUSTED/);
  assert.equal(budget.used, 2);
});

test('metadata-only answer remains valid for the existing large-schema question, not money questions', () => {
  const observed = qualityEvidence();
  observed.observe(undefined, false, {
    action: 'describe',
    engine: 'postgresql',
    sections: {
      columns: { status: 'available', columns: ['name'], rows: [['id']], truncated: false },
    },
    nextOffset: null,
    cache: { hit: false, ageMs: 0, ttlMs: 60000 },
    durationMs: 0,
    readOnly: true,
  });
  assert.equal(
    gradeAnswer({ id: 'postgresql-large-schema', answer: 'id' }, 'id', observed.evidence),
    true,
  );
  assert.equal(gradeAnswer(qualityCases[0], qualityCases[0].answer, observed.evidence), false);
});
