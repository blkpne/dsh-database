import React, { useSyncExternalStore } from 'react';
import { Manager } from './manager';
import css from './style.css';

export const inject = ['slots'];
interface ClientContext {
  slots: {
    inject(name: string, callback: () => () => void): unknown;
    register(
      options: { name: string; id: string; order: number },
      component: React.ComponentType,
    ): () => void;
  };
  effect(callback: () => () => void, label: string): unknown;
}

function DatabaseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </svg>
  );
}

export function apply(ctx: ClientContext) {
  let open = false;
  const listeners = new Set<() => void>();
  const setOpen = (value: boolean) => {
    open = value;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function Entry() {
    return (
      <button
        className="dshdb-entry"
        type="button"
        title="数据库"
        aria-label="数据库"
        onClick={() => setOpen(true)}
      >
        <DatabaseIcon />
        <span>数据库</span>
      </button>
    );
  }
  function Overlay() {
    const visible = useSyncExternalStore(subscribe, () => open);
    return visible ? <Manager onClose={() => setOpen(false)} /> : null;
  }
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => {
      style.remove();
      setOpen(false);
      listeners.clear();
    };
  }, 'dsh-database.styles');
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-database', order: 30 }, Entry),
  );
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-database', order: 100 }, Overlay),
  );
}
