import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('Client registers a host-owned panel entry and clears drafts/listeners on unload and reload', async () => {
  const bundle = await build({
    entryPoints: ['src/client/index.tsx'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    loader: { '.css': 'text' },
  });
  const entries = new Map();
  const listeners = new Map();
  const styles = new Set();
  const document = {
    documentElement: { lang: 'zh-CN' },
    createElement: () => ({
      remove() {
        styles.delete(this);
      },
    }),
    head: { append: (style) => styles.add(style) },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    require: createRequire(import.meta.url),
    module,
    exports: module.exports,
    document,
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => {
        if (listeners.get(name) === listener) listeners.delete(name);
      },
    },
  });
  const mount = () => {
    const effects = [];
    module.exports.apply({
      effect: (effect) => effects.push(effect()),
      slots: {
        inject: (name, register) => {
          assert(['main', 'sidebar.panellist'].includes(name));
          effects.push(register());
        },
        register: (options, component) => {
          const key = options.name === 'main' ? options.key : options.id;
          assert(key);
          assert(!entries.has(options.name));
          entries.set(options.name, { options, component });
          return () => entries.delete(options.name);
        },
      },
    });
    return () => effects.reverse().forEach((dispose) => dispose());
  };
  const dispose = mount();
  const main = entries.get('main');
  const sidebar = entries.get('sidebar.panellist');
  assert.equal(main.options.key, sidebar.options.id);
  assert.equal(main.options.id, undefined);
  assert.equal(sidebar.options.label(), '数据库');
  document.documentElement.lang = 'en';
  assert.equal(sidebar.options.label(), 'Database');
  const icon = sidebar.component({ size: 16, active: true });
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.width, 16);
  assert.equal(icon.props['aria-hidden'], 'true');
  const session = main.component().props.session;
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  };
  listeners.get('beforeunload')(event);
  assert.equal(prevented, false);
  session.write({ dirty: true, draft: { password: 'fixture-only' } });
  listeners.get('beforeunload')(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  dispose();
  assert.equal(entries.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(styles.size, 0);
  assert.equal(session.read(), undefined);
  session.write({ dirty: true });
  assert.equal(session.read(), undefined);
  const disposeReloaded = mount();
  assert.equal(entries.get('main').component().props.session.read(), undefined);
  assert.equal(entries.size, 2);
  disposeReloaded();
  assert.equal(styles.size, 0);
});
