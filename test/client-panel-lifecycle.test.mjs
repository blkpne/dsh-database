import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Exercise the actual Manager handlers and activation snapshot without a DOM.
// This hook scheduler is a logic regression fixture, not browser/React acceptance.
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export { Manager } from './src/client/manager.tsx';
      export { PanelSession } from './src/client/panel-session.ts';
      export { emptyDraft, toDraft } from './src/client/model.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
});
const response = (data, ok = true) => ({
  ok,
  status: ok ? 200 : 400,
  headers: { get: () => 'application/json' },
  json: async () => data,
});
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
}
function harness(writeResponse, { clean = false, existing = false } = {}) {
  let hooks = [],
    cursor = 0,
    layouts = [],
    effects = [],
    changed = false,
    tree;
  let connections = [];
  const fakeReact = {
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [
        hooks[i],
        (v) => {
          const next = typeof v === 'function' ? v(hooks[i]) : v;
          if (next !== hooks[i]) changed = true;
          hooks[i] = next;
        },
      ];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: init };
      return hooks[i];
    },
    useLayoutEffect(fn) {
      cursor++;
      layouts.push(fn);
    },
    useEffect(fn, deps) {
      const i = cursor++,
        previous = hooks[i];
      if (!previous || !deps || deps.some((d, k) => d !== previous.deps[k]))
        effects.push(() => {
          previous?.cleanup?.();
          hooks[i] = { deps, cleanup: fn() };
        });
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name) => (name === 'react' ? fakeReact : require(name)),
    AbortController,
    AbortSignal,
    HTMLElement: class {},
    HTMLDetailsElement: class {},
    document: { activeElement: null },
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    cancelAnimationFrame() {},
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      return body.action === 'list'
        ? response({ ok: true, connections })
        : writeResponse(body, (next) => {
            connections = next;
          });
    },
  });
  const { Manager, PanelSession, emptyDraft, toDraft } = module.exports;
  const record = {
    ...emptyDraft(),
    id: '0123456789abcdef',
    revision: 1,
    name: 'Saved',
    hasPassword: true,
    enabled: true,
    status: 'enabled',
    toolName: 'synthetic',
  };
  connections = existing ? [record] : [];
  const session = new PanelSession();
  session.write({
    connections,
    selected: existing ? record.id : undefined,
    draft: clean
      ? emptyDraft()
      : { ...(existing ? toDraft(record) : emptyDraft()), name: 'Draft', user: 'reader' },
    view: 'settings',
    policyOpen: true,
    dirty: !clean,
    conflict: false,
    pendingMutation: false,
    checking: false,
    scrollTop: 0,
  });
  function render() {
    do {
      changed = false;
      cursor = 0;
      layouts = [];
      tree = Manager({ session });
      layouts.forEach((fn) => fn());
      const batch = effects;
      effects = [];
      batch.forEach((fn) => fn());
    } while (changed);
  }
  const settle = async () => {
    await nextTurn();
    render();
  };
  return {
    session,
    record,
    render,
    settle,
    saveDisabled: () =>
      find(tree, (n) => n.type === 'button' && n.props.type === 'submit').props.disabled,
    control: (label) =>
      find(
        tree,
        (n) =>
          n.type === 'button' && (n.props['aria-label'] === label || n.props.children === label),
      ),
    async mount() {
      render();
      await settle();
    },
    async save() {
      find(tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
      render();
      await settle();
    },
    async remount() {
      for (const hook of hooks) hook?.cleanup?.();
      hooks = [];
      effects = [];
      render();
      await settle();
    },
  };
}

test('failed writes remain guarded when failure precedes navigation', async () => {
  for (const write of [
    () => {
      throw new TypeError('synthetic network failure');
    },
    () => ({ ...response(null), headers: { get: () => 'text/html' } }),
    () => ({
      ...response(null),
      json: async () => {
        throw new SyntaxError('truncated');
      },
    }),
    () => response({ ok: true }),
    () => response({ ok: true, connections: [null] }),
    () => response({ ok: false, code: 'ERROR', message: 'Unknown outcome' }, false),
    () => response({ ok: false, committed: true, connectionId: 'missing', connections: [] }, false),
  ]) {
    const h = harness(write);
    await h.mount();
    await h.save();
    assert.equal(h.session.read().conflict, true);
    assert.equal(h.saveDisabled(), true);
    await h.remount();
    assert.equal(h.session.read().draft.name, 'Draft');
    assert.equal(h.session.read().conflict, true);
    assert.equal(h.saveDisabled(), true);
  }
});

test('a complete preflight rejection permits correcting the draft after navigation', async () => {
  const h = harness(() =>
    response({ ok: false, code: 'INVALID_INPUT', message: 'Invalid input' }, false),
  );
  await h.mount();
  await h.save();
  await h.remount();
  assert.equal(h.session.read().conflict, false);
  assert.equal(h.saveDisabled(), false);
});

test('committed responses adopt only the requested record and unknown writes block all mutations', async () => {
  let h;
  h = harness(
    (_body, update) => {
      const saved = { ...h.record, name: 'Draft', user: 'reader', revision: 2 };
      update([saved]);
      return response(
        { ok: false, code: 'ERROR', committed: true, connectionId: saved.id, connections: [saved] },
        false,
      );
    },
    { existing: true },
  );
  await h.mount();
  await h.save();
  await h.remount();
  assert.equal(h.session.read().conflict, false);
  assert.equal(h.session.read().selected, h.record.id);
  assert.equal(h.session.read().dirty, false);
  const wrong = harness(
    () =>
      response(
        {
          ok: false,
          committed: true,
          connectionId: 'other',
          connections: [{ ...h.record, id: 'other' }],
        },
        false,
      ),
    { existing: true },
  );
  await wrong.mount();
  await wrong.save();
  await wrong.remount();
  assert.equal(wrong.session.read().conflict, true);
  assert.equal(wrong.saveDisabled(), true);
  assert.equal(wrong.control('Agent 访问').props.disabled, true);
  assert.equal(wrong.control('删除连接').props.disabled, true);
});

test('clean navigation retains optional authorization expansion without creating a dirty draft', async () => {
  const h = harness(
    () => {
      throw new Error('No write expected');
    },
    { clean: true },
  );
  await h.mount();
  await h.remount();
  assert.equal(h.session.read().policyOpen, true);
  assert.equal(h.session.read().dirty, false);
  assert.equal(h.session.needsExitWarning, false);
});

test('unconfirmed removal disables its confirmation but keeps cancel available', async () => {
  const h = harness(
    () => {
      throw new TypeError('synthetic response lost');
    },
    { existing: true },
  );
  await h.mount();
  h.control('删除连接').props.onClick();
  h.render();
  h.control('确认删除').props.onClick();
  h.render();
  await h.settle();
  assert.equal(h.session.read().conflict, true);
  assert.equal(h.control('确认删除').props.disabled, true);
  assert.equal(h.control('取消').props.disabled, false);
});
