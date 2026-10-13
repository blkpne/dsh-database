import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { evaluationFixture } from './evaluation/fixture.js';
import { evaluations } from './evaluation/cases.js';
import { queryResult } from '../src/schema.js';

// Verifies the answer key through real MCP and a deterministic SQL fixture; no online LLM involved.
test('ten independent evaluation answers are verified through discovery and actual SQL tool calls', async () => {
  const fixture = evaluationFixture();
  const client = new Client({ name: 'evaluation-verifier', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await fixture.server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools[0]?.name, 'query');
    const query = async (sql: string) => {
      const result = await client.callTool({ name: 'query', arguments: { sql } });
      assert(!result.isError, JSON.stringify(result));
      return queryResult.parse(result.structuredContent);
    };
    const xml = await readFile(new URL('./evaluation/evaluations.xml', import.meta.url), 'utf8');
    assert.equal(evaluations.length, 10);
    assert.deepEqual(
      [...xml.matchAll(/<question>(.*?)<\/question>\s*<answer>(.*?)<\/answer>/gs)].map((match) => [
        match[1],
        match[2],
      ]),
      evaluations.map((item) => [item.question, item.answer]),
    );
    for (const evaluation of evaluations) {
      assert.equal((await query('SHOW TABLES')).rowCount, 3);
      await query('DESCRIBE orders');
      const result = await query(evaluation.sql);
      assert.equal(result.truncated, false);
      assert.equal(String(result.rows[0]?.[0]), evaluation.answer, evaluation.question);
      assert(xml.includes(`<answer>${evaluation.answer}</answer>`));
    }
    assert((await query('SELECT id FROM customers ORDER BY id')).truncated);
    const first = await query('SELECT id FROM customers ORDER BY id LIMIT 3');
    const next = await query('SELECT id FROM customers ORDER BY id LIMIT 3 OFFSET 3');
    assert.deepEqual([...first.rows, ...next.rows], [[1], [2], [3], [4], [5]]);
  } finally {
    await client.close();
    await fixture.close();
  }
});
