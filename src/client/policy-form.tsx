import React, { useEffect, useState } from 'react';
import type { Connection, Draft } from './model';

export function PolicyForm({
  draft,
  current,
  disabled,
  active,
  change,
}: {
  draft: Draft;
  current?: Connection;
  disabled: boolean;
  active: boolean;
  change: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const [sessionText, setSessionText] = useState(draft.policy.sessionIds.join('\n'));
  useEffect(
    () => setSessionText(draft.policy.sessionIds.join('\n')),
    [current?.id, current?.revision],
  );
  useEffect(() => {
    setSessionText((text) => {
      const ids = text
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      return JSON.stringify(ids) === JSON.stringify(draft.policy.sessionIds)
        ? text
        : draft.policy.sessionIds.join('\n');
    });
  }, [draft.policy.sessionIds]);
  const [scopes, setScopes] = useState<
    { id: string; workspace?: string; createdAt?: number; child?: boolean }[]
  >([]);
  const [scopeError, setScopeError] = useState('');
  useEffect(() => {
    if (!active || draft.policy.access !== 'sessions') return;
    const controller = new AbortController();
    setScopeError('');
    void fetch('/api/dsh-database', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'scopes' }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (response) => {
        if (response.ok) {
          const value = await response.json();
          setScopes(value.scopes ?? []);
        } else throw new Error('scopes unavailable');
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setScopeError('活动会话读取失败，可重新展开访问规则重试，或填写已知会话 ID。');
      });
    return () => controller.abort();
  }, [active, draft.policy.access]);
  const set = (value: Partial<Draft['policy']>) => change('policy', { ...draft.policy, ...value });
  return (
    <fieldset className="dshdb-policy" disabled={disabled}>
      <legend className="dshdb-sr-only">访问约束</legend>
      {current?.effectivePolicy?.usesDefaultPolicy && (
        <p className="dshdb-field-help">
          此连接尚未单独保存授权策略，当前使用“当前 DSH 的所有会话”。请按需要设置并保存访问约束。
        </p>
      )}
      <label>
        允许的操作
        <select
          value={draft.policy.mode}
          onChange={(e) => set({ mode: e.target.value as Draft['policy']['mode'] })}
        >
          <option value="query">结构发现与只读查询</option>
          <option value="metadata">仅结构发现</option>
        </select>
      </label>
      <p className="dshdb-field-help">
        仅结构发现不提供查询工具，也不能通过执行入口读取业务行；MongoDB 不抽样业务文档。
      </p>
      <label>
        授权范围
        <select
          value={draft.policy.access}
          onChange={(e) => set({ access: e.target.value as Draft['policy']['access'] })}
        >
          <option value="host">当前 DSH 的所有会话</option>
          <option value="sessions">指定会话及其子 Agent</option>
        </select>
      </label>
      {draft.policy.access === 'sessions' && (
        <>
          <label>
            添加活动会话
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  const sessionIds = [...new Set([...draft.policy.sessionIds, e.target.value])];
                  set({ sessionIds });
                  setSessionText(sessionIds.join('\n'));
                }
              }}
            >
              <option value="">选择宿主中的活动会话</option>
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {`${scope.workspace ?? '未指定工作区'}${scope.child ? ' · 子 Agent' : ''}${scope.createdAt ? ` · ${new Date(scope.createdAt).toLocaleString()}` : ''} · ${scope.id}`}
                </option>
              ))}
            </select>
          </label>
          {scopeError && (
            <p role="alert" className="dshdb-field-help">
              {scopeError}
            </p>
          )}
          {draft.policy.sessionIds.length > 0 && (
            <ul className="dshdb-field-help">
              {draft.policy.sessionIds.map((id) => {
                const scope = scopes.find((entry) => entry.id === id);
                return (
                  <li key={id}>
                    {scope?.workspace ?? '未加载或未指定工作区'} · {id}
                  </li>
                );
              })}
            </ul>
          )}
          <label>
            授权会话 ID（每行一个，最多 20 个）
            <textarea
              required
              rows={3}
              value={sessionText}
              onChange={(e) => {
                setSessionText(e.target.value);
                set({
                  sessionIds: e.target.value
                    .split('\n')
                    .map((v) => v.trim())
                    .filter(Boolean),
                });
              }}
            />
          </label>
          <p className="dshdb-field-help">
            以宿主真实作用域判断继承。重启后相同会话 ID 保留授权；复制会话记录不会自动获得授权。
          </p>
        </>
      )}
      <div className="dshdb-limit-grid">
        <label>
          每分钟调用上限
          <input
            type="number"
            min={1}
            max={600}
            required
            value={draft.policy.callsPerMinute}
            onChange={(e) => set({ callsPerMinute: Number(e.target.value) })}
          />
        </label>
        <label>
          每小时调用上限
          <input
            type="number"
            min={1}
            max={10000}
            required
            value={draft.policy.callsPerHour}
            onChange={(e) => set({ callsPerHour: Number(e.target.value) })}
          />
        </label>
      </div>
      <p className="dshdb-field-help">
        结构发现、缓存命中和查询共用额度，子 Agent
        与顶层所属会话共享。额度按时钟窗口计算，插件重载后重新计数。最大行数和超时在连接设置中配置。
      </p>
      <p className="dshdb-policy-boundary">
        表和列的访问范围由数据库只读账户及授权决定。结构搜索的名称过滤不构成数据权限边界。
      </p>
    </fieldset>
  );
}
