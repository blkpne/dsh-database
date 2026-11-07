export type SessionChoice = {
  id: string;
  workspace?: string;
  createdAt?: number;
  child?: boolean;
};

export function sessionLabel(scope: SessionChoice): string {
  const created = scope.createdAt == null ? undefined : new Date(scope.createdAt);
  return [
    scope.workspace || '未指定工作区',
    scope.child ? '子 Agent' : '会话',
    created && Number.isFinite(created.getTime()) ? created.toLocaleString() : undefined,
    scope.id,
  ]
    .filter(Boolean)
    .join(' · ');
}

export async function loadSessionChoices(signal: AbortSignal): Promise<SessionChoice[]> {
  const response = await fetch('/api/dsh-database', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'scopes' }),
    signal,
  });
  if (!response.ok) throw new Error('scopes unavailable');
  const value = await response.json();
  // Closing the section or refreshing must not let an older response replace the current list.
  signal.throwIfAborted();
  if (!Array.isArray(value.scopes)) throw new Error('scopes unavailable');
  return value.scopes;
}
