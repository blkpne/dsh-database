import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstQuestion,
  firstQuestionBlock,
  QuestionCopy,
  FirstConnectionHint,
} from '../src/client/first-question.js';
import { emptyDraft } from '../src/client/model.js';
import type { Connection } from '../src/client/model.js';

const connection: Connection = {
  ...emptyDraft(),
  id: '0123456789abcdef',
  revision: 1,
  name: 'Synthetic',
  tls: true,
  enabled: true,
  status: 'enabled',
  hasPassword: true,
  toolName: 'mcp__dshdb_0123456789abcdef__query',
};

test('first-question handoff refuses drafts, disabled/error connections and ambiguous names', () => {
  assert.equal(firstQuestionBlock(connection, [connection], false), undefined);
  assert.match(firstQuestionBlock(connection, [connection], true)!, /保存或取消修改/);
  assert.match(firstQuestionBlock({ ...connection, enabled: false }, [connection], false)!, /开启/);
  assert.match(
    firstQuestionBlock({ ...connection, status: 'disabled' }, [connection], false)!,
    /开启/,
  );
  assert.match(
    firstQuestionBlock({ ...connection, status: 'error' }, [connection], false)!,
    /错误/,
  );
  assert.match(
    firstQuestionBlock(
      connection,
      [connection, { ...connection, id: 'different', name: ' SYNTHETIC ' }],
      false,
    )!,
    /同名/,
  );
  assert.equal(
    firstQuestionBlock(
      connection,
      [connection, { ...connection, id: 'different', name: 'Other' }],
      false,
    ),
    undefined,
  );
});

test('first question uses the saved connection name and remains structure-only for both policy modes', () => {
  for (const mode of ['metadata', 'query'] as const) {
    const saved = { ...connection, policy: { ...emptyDraft().policy, mode } };
    assert.match(firstQuestion(saved), /「Synthetic」/);
    assert.match(firstQuestion(saved), /只查看结构，不读取业务行/);
    assert.match(firstQuestion(saved), /不要改用其他连接/);
    assert.doesNotMatch(firstQuestion(saved), /mcp__|password/);
    assert.match(firstQuestion({ ...saved, engine: 'mongodb' }), /集合/);
  }
});

test('duplicate copy clicks write once, and closing or changing connection prevents late feedback', async () => {
  for (const reason of ['closed', 'changed']) {
    const action = new QuestionCopy();
    let resolve!: () => void;
    let writes = 0;
    let completions = 0;
    let current = true;
    const write = () => {
      writes++;
      return new Promise<void>((done) => {
        resolve = done;
      });
    };
    const first = action.run(
      'saved prompt',
      write,
      () => current,
      () => completions++,
      () => assert.fail('not a write failure'),
    );
    await action.run(
      'duplicate',
      write,
      () => current,
      () => completions++,
      () => assert.fail(),
    );
    assert.equal(writes, 1);
    if (reason === 'closed') action.cancel();
    else current = false;
    resolve();
    await first;
    assert.equal(completions, 0);
    await action.run(
      'new prompt',
      async () => {
        writes++;
      },
      () => true,
      () => completions++,
      () => assert.fail(),
    );
    assert.equal(completions, 1);
    assert.equal(writes, 2);
  }
});

test('clipboard rejection preserves the screen for manual copy and supports a later retry', async () => {
  const action = new QuestionCopy();
  let completions = 0;
  let failures = 0;
  await action.run(
    'prompt',
    async () => {
      throw new Error('permission denied');
    },
    () => true,
    () => completions++,
    () => failures++,
  );
  assert.equal(completions, 0);
  assert.equal(failures, 1);
  await action.run(
    'prompt',
    async () => {},
    () => true,
    () => completions++,
    () => failures++,
  );
  assert.equal(completions, 1);
  assert.equal(failures, 1);
});

test('first connection hint is offered once after success and stays dismissed across manager remounts', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const hint = new FirstConnectionHint(() => storage, { offered: false });
  hint.observeExisting(0);
  assert.equal(values.size, 0, 'empty list or failed creation does not mark completion');
  assert.equal(hint.claim(), true);
  assert.equal(hint.claim(), false);
  assert.equal(new FirstConnectionHint(() => storage, { offered: false }).claim(), false);
  assert.deepEqual([...values.values()], ['1'], 'no connection data is persisted');
});

test('existing users and blocked browser storage never cause recurring guidance or configuration failures', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const existing = new FirstConnectionHint(() => storage, { offered: false });
  existing.observeExisting(1);
  assert.equal(existing.claim(), false);
  assert.equal(
    new FirstConnectionHint(() => storage, { offered: false }).claim(),
    false,
    'even after deleting the last connection',
  );
  const blocked = () => {
    throw new Error('Storage unavailable');
  };
  const page = { offered: false };
  const first = new FirstConnectionHint(blocked, page);
  assert.equal(first.claim(), true);
  assert.equal(new FirstConnectionHint(blocked, page).claim(), false);
});
