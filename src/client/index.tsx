import React from 'react';
import { PanelSession } from './panel-session';
import { Manager } from './manager';
import css from './style.css';

export const inject = ['slots'];
interface ClientContext {
  slots: {
    inject(name: string, callback: () => () => void): unknown;
    register(
      options:
        | { name: 'main'; key: string }
        | { name: 'sidebar.panellist'; id: string; order: number; label: () => string },
      component: React.ComponentType<{ size?: number }>,
    ): () => void;
  };
  effect(callback: () => () => void, label: string): unknown;
}

function DatabaseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
  const session = new PanelSession();
  function Panel() {
    return <Manager session={session} />;
  }
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (!session.needsExitWarning) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => {
      window.removeEventListener('beforeunload', protectDraft);
      session.dispose();
      style.remove();
    };
  }, 'dsh-database.styles');
  // The official root main slot is keyed; the sidebar list uses the same value as its id.
  // Register the destination first so the host never exposes a dangling navigation row.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-database' }, Panel));
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'dsh-database',
        order: 30,
        label: () => (/^en(?:-|$)/i.test(document.documentElement.lang) ? 'Database' : '数据库'),
      },
      DatabaseIcon,
    ),
  );
}
