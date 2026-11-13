import React, { useEffect, useState } from 'react';
import type { Connection, Draft } from './model';
import { loadSessionChoices, sessionLabel } from './session-choices';
import type { SessionChoice } from './session-choices';

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
  const [scopes, setScopes] = useState<SessionChoice[]>([]);
  const [scopeError, setScopeError] = useState('');
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeRefresh, setScopeRefresh] = useState(0);
  useEffect(() => {
    if (!active || draft.policy.access !== 'sessions') return;
    const controller = new AbortController();
    setScopeError('');
    setScopes([]);
    setScopeLoading(true);
    void loadSessionChoices(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      .then((choices) => {
        if (!controller.signal.aborted) setScopes(choices);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setScopeError('活动会话读取失败，请刷新重试，或填写已知会话 ID。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setScopeLoading(false);
      });
    return () => controller.abort();
  }, [active, draft.policy.access, scopeRefresh]);
  const set = (value: Partial<Draft['policy']>) => change('policy', { ...draft.policy, ...value });
  return (
    <fieldset className="dshdb-policy" disabled={disabled}>
      <legend className="dshdb-sr-only">访问约束</legend>
      {current?.effectivePolicy?.usesDefaultPolicy && (
        <p className="dshdb-field-help">
          此连接尚未单独保存授权策略，当前使用“当前 DSH 的所有会话”。请按需要设置并保存访问约束。
        </p>
      )}
      <label className="dshdb-policy-described">
        允许的操作
        <select
          aria-describedby="dshdb-policy-mode-help"
          value={draft.policy.mode}
          onChange={(e) => set({ mode: e.target.value as Draft['policy']['mode'] })}
        >
          <option value="query">结构发现与只读查询</option>
          <option value="metadata">仅结构发现</option>
        </select>
      </label>
      <p className="dshdb-field-help" id="dshdb-policy-mode-help">
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
          <label className="dshdb-policy-described">
            添加活动会话
            <select
              aria-describedby="dshdb-session-picker-help"
              value=""
              disabled={scopeLoading || scopes.length === 0}
              onChange={(e) => {
                if (e.target.value) {
                  const sessionIds = [...new Set([...draft.policy.sessionIds, e.target.value])];
                  set({ sessionIds });
                  setSessionText(sessionIds.join('\n'));
                }
              }}
            >
              <option value="">
                {scopeLoading ? '正在读取活动会话…' : '选择宿主中的活动会话'}
              </option>
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {sessionLabel(scope)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="dshdb-button dshdb-secondary dshdb-policy-refresh"
            disabled={scopeLoading}
            onClick={() => setScopeRefresh((value) => value + 1)}
          >
            刷新活动会话
          </button>
          <p className="dshdb-field-help" id="dshdb-session-picker-help" role="status">
            {scopeLoading
              ? '正在读取活动会话…'
              : !scopeError && scopes.length === 0
                ? '暂无活动会话。先在宿主中打开目标对话，再刷新；也可填写已知会话 ID。'
                : '仅列出宿主当前已加载的活动会话，不是全部历史对话。新打开对话后请刷新。'}
          </p>
          {scopeError && (
            <p role="alert" className="dshdb-field-help">
              {scopeError}
            </p>
          )}
          {draft.policy.sessionIds.length > 0 && (
            <ul className="dshdb-selected-sessions">
              {draft.policy.sessionIds.map((id) => {
                const scope = scopes.find((entry) => entry.id === id);
                return (
                  <li key={id}>
                    <span className="dshdb-selected-session-name">
                      {scope ? sessionLabel(scope) : `未在活动列表中 · ${id}`}
                    </span>
                    <button
                      type="button"
                      className="dshdb-button dshdb-secondary"
                      aria-label={`移除授权会话 ${id}`}
                      onClick={() =>
                        set({ sessionIds: draft.policy.sessionIds.filter((entry) => entry !== id) })
                      }
                    >
                      移除
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <label className="dshdb-policy-described">
            授权会话 ID（每行一个，最多 20 个）
            <textarea
              aria-describedby="dshdb-policy-session-help"
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
          <p className="dshdb-field-help" id="dshdb-policy-session-help">
            添加或移除会话后需保存才会生效。未出现在活动列表中不代表授权失效。以宿主真实作用域判断继承。重启后相同会话
            ID 保留授权；复制会话记录不会自动获得授权。
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
