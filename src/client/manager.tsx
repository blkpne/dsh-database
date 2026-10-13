import React, { useEffect, useRef, useState } from 'react';
import { PolicyForm } from './policy-form';
import { Activity } from './activity';
import { CallDetails, outcome } from './call-record';
import type { Observatory, Trace } from '../observability.js';
import { safeError } from '../errors.js';
import { ConnectionForm } from './connection-form';
import {
  emptyDraft,
  hasChanges,
  statusLabel,
  toDraft,
  switchEngine,
  savedConnection,
} from './model';
import type { Connection, Draft, SaveResponse } from './model';
import { engines } from '../engines.js';
import type { Engine } from '../engines.js';

type View = 'settings' | 'activity';
type Check = 'test' | 'diagnose';
type CheckResult = { text: string; error: boolean; trace?: Trace };
type Snapshot = ReturnType<Observatory['snapshot']>;
const views = [
  { id: 'settings', label: '连接设置' },
  { id: 'activity', label: '调用记录' },
] as const;
type Destination = { id?: string; close?: boolean; refresh?: boolean };
type Confirmation = { kind: 'discard'; destination: Destination } | { kind: 'delete' };
type ListResponse = { connections: Connection[] };
class ApiFailure extends Error {
  constructor(
    message: string,
    readonly data?: { committed?: boolean; connectionId?: string; connections?: Connection[] },
  ) {
    super(message);
  }
}

export function Manager({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const checkHeading = useRef<HTMLHeadingElement>(null);
  const accessHeading = useRef<HTMLHeadingElement>(null);
  const controller = useRef(new AbortController());
  const activeOperation = useRef(false);
  const probe = useRef<AbortController>();
  const [checking, setChecking] = useState<Check>();
  const [checkResult, setCheckResult] = useState<CheckResult>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [view, setView] = useState<View>('settings');
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('正在读取连接…');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [accessNotice, setAccessNotice] = useState<{ text: string; error: boolean }>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const current = connections.find((c) => c.id === selected);
  const dirty = hasChanges(draft, current);
  const locked = !!busy || !!confirmation || !loaded;

  useEffect(() => {
    const lifecycle = new AbortController();
    controller.current = lifecycle;
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    void request<ListResponse>({ action: 'list' })
      .then((data) => {
        if (lifecycle.signal.aborted) return;
        setConnections(data.connections);
        select(data.connections[0]);
        setLoaded(true);
      })
      .catch(report)
      .finally(() => {
        if (!lifecycle.signal.aborted) setBusy('');
      });
    return () => {
      lifecycle.abort();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const previousFocus = document.activeElement;
    cancel.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [confirmation]);

  async function request<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch('/api/dsh-database', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([
          controller.current.signal,
          AbortSignal.timeout(
            payload.action === 'test' || payload.action === 'diagnose'
              ? Number(draft.timeoutMs || 15000) + 5000
              : 30000,
          ),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new Error(
        '未收到 DSH 的完整响应，操作状态尚未确认。请刷新列表核对，不要直接重复提交。',
      );
    }
    if (response.status === 401) throw new Error('登录已失效，请刷新 DSH 页面。');
    if (response.status === 403) throw new Error('宿主拒绝此请求，请使用 DSH 本机页面。');
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('DSH 未返回有效响应，请刷新列表重试。');
    const data = await response.json();
    if (!response.ok || !data.ok)
      throw new ApiFailure(data.message || '操作失败，请稍后重试。', data);
    return data;
  }

  function report(error: unknown, target: 'general' | 'access' = 'general') {
    if ((error as Error)?.name !== 'AbortError' && !controller.current.signal.aborted)
      (target === 'access' ? setAccessNotice : setNotice)({
        error: true,
        text: error instanceof Error ? error.message : '操作失败，请重试。',
      });
  }

  async function act(
    label: string,
    operation: () => Promise<void>,
    mutation?: 'save' | 'toggle' | 'remove',
  ) {
    if (busy || activeOperation.current) return;
    cancelCheck(false);
    setCheckResult(undefined);
    activeOperation.current = true;
    setBusy(label);
    setNotice(undefined);
    setAccessNotice(undefined);
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApiFailure && error.data?.committed && error.data.connections) {
        const latest = error.data.connections;
        setConnections(latest);
        if (mutation === 'save') select(latest.find((c) => c.id === error.data?.connectionId));
        if (mutation === 'remove') select(latest[0]);
      }
      report(error, mutation === 'toggle' ? 'access' : 'general');
    } finally {
      activeOperation.current = false;
      if (!controller.current.signal.aborted) setBusy('');
    }
  }

  function select(connection?: Connection) {
    setPolicyOpen(false);
    setCheckResult(undefined);
    if (!connection) setView('settings');
    setSelected(connection?.id);
    setDraft(connection ? toDraft(connection) : emptyDraft());
    setNotice(undefined);
    setAccessNotice(undefined);
    setConfirmation(undefined);
    scroller.current?.scrollTo({ top: 0 });
  }

  function switchView(next: View) {
    if (locked || next === view) return;
    cancelCheck();
    setNotice(undefined);
    setView(next);
    tabButtons.current[views.findIndex((item) => item.id === next)]?.focus();
    scroller.current?.scrollTo({ top: 0 });
  }

  function focusSection(section: 'checks' | 'access') {
    const heading = (section === 'checks' ? checkHeading : accessHeading).current;
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }

  function navigate(destination: Destination, force = false) {
    if (busy || activeOperation.current) return;
    cancelCheck(false);
    if (dirty && !force) {
      setConfirmation({ kind: 'discard', destination });
      return;
    }
    setConfirmation(undefined);
    if (destination.close) onClose();
    else if (destination.refresh) {
      void act('正在刷新列表…', async () => {
        const data = await request<ListResponse>({ action: 'list' });
        setConnections(data.connections);
        select(data.connections.find((c) => c.id === selected) ?? data.connections[0]);
        setLoaded(true);
        setNotice({ error: false, text: '连接列表已刷新。' });
      });
    } else select(connections.find((c) => c.id === destination.id));
  }

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setCheckResult(undefined);
    setAccessNotice(undefined);
    setDraft((d) =>
      key === 'engine'
        ? switchEngine(d, value as Engine)
        : key === 'mongoSrv' && value
          ? { ...d, mongoSrv: true, port: 27017, tls: true }
          : { ...d, [key]: value },
    );
    setNotice(undefined);
  }

  function save() {
    if (locked || (current && !dirty)) return;
    void act(
      '正在保存连接…',
      async () => {
        const data = await request<SaveResponse>({
          action: 'save',
          connection: draft,
          id: selected,
          revision: current?.revision,
        });
        const saved = savedConnection(data);
        setConnections(data.connections);
        select(saved);
        setNotice({
          error: saved?.status === 'error',
          text:
            saved?.error ??
            (saved?.enabled
              ? '修改已保存，Agent 访问已更新。'
              : '连接已保存。开启 Agent 访问后即可在对话中使用。'),
        });
      },
      'save',
    );
  }

  function cancelCheck(showResult = true) {
    if (!probe.current) return;
    probe.current.abort();
    probe.current = undefined;
    if (showResult && checking)
      setCheckResult({
        error: false,
        text: '已取消等待结果；服务端会处理取消，尚未确认执行是否已停止。',
      });
    setChecking(undefined);
  }

  async function runCheck(kind: Check) {
    if (locked || probe.current) return;
    if (kind === 'diagnose' ? !current || dirty : !form.current?.reportValidity()) return;
    const own = new AbortController();
    probe.current = own;
    setChecking(kind);
    setCheckResult(undefined);
    try {
      if (kind === 'diagnose' && current) {
        const data = await request<{ trace: Trace; observations: Snapshot }>(
          { action: 'diagnose', id: current.id, revision: current.revision },
          own.signal,
        );
        if (probe.current !== own || controller.current.signal.aborted) return;
        const trace = data.trace;
        if (
          !trace ||
          trace.operation !== 'diagnose' ||
          trace.revision !== current.revision ||
          trace.connectionId !== current.id ||
          trace.outcome === 'running'
        )
          throw new Error('未收到本次诊断的完整结果，请到调用记录核对。');
        setCheckResult({
          error: trace.outcome !== 'success',
          trace,
          text:
            trace.outcome === 'success'
              ? '诊断通过：已保存的配置可连接，并完成结构访问检查。不代表所有业务表均可读取。'
              : `诊断${outcome[trace.outcome]}。${trace.code ? safeError({ code: trace.code }).message : '请展开诊断详情定位失败阶段。'}`,
        });
      } else {
        const data = await request<{ result: { rows: unknown[][] } }>(
          { action: 'test', connection: draft, id: selected },
          own.signal,
        );
        if (probe.current !== own || controller.current.signal.aborted) return;
        if (!Array.isArray(data.result?.rows))
          throw new Error('未收到完整的连接测试结果，请重试。');
        setCheckResult({
          error: false,
          text: `连接测试通过：当前填写的配置可连接并执行探测查询。${dirty || !current ? '配置尚未保存。' : ''}测试不代表所有业务表均可访问。`,
        });
      }
    } catch (error) {
      if (probe.current === own && !controller.current.signal.aborted)
        setCheckResult({
          error: true,
          text: error instanceof Error ? error.message : '连接检查失败，请重试。',
        });
    } finally {
      if (probe.current === own) {
        probe.current = undefined;
        setChecking(undefined);
      }
    }
  }

  function toggle() {
    if (!current || locked || (dirty && !current.enabled)) return;
    const enabled = !current.enabled;
    void act(
      enabled ? '正在开启 Agent 访问…' : '正在停用 Agent 访问…',
      async () => {
        const data = await request<ListResponse>({
          action: 'toggle',
          id: current.id,
          revision: current.revision,
          enabled,
        });
        setConnections(data.connections);
        const updated = data.connections.find((c) => c.id === current.id);
        setAccessNotice({
          error: updated?.status === 'error',
          text:
            updated?.error ??
            (enabled ? 'Agent 访问已开启，可在对话中使用此连接。' : 'Agent 访问已关闭。'),
        });
      },
      'toggle',
    );
  }

  function remove() {
    if (!current) return;
    void act(
      '正在删除连接…',
      async () => {
        const data = await request<ListResponse>({
          action: 'remove',
          id: current.id,
          revision: current.revision,
        });
        setConnections(data.connections);
        select(data.connections[0]);
        setNotice({ error: false, text: '连接已删除，查询工具已撤销。' });
      },
      'remove',
    );
  }

  const enabledCount = connections.filter((c) => c.status === 'enabled').length;
  const changingAccess = busy === '正在开启 Agent 访问…' || busy === '正在停用 Agent 访问…';
  const accessError = !changingAccess && !!(accessNotice?.error || current?.error);
  return (
    <dialog
      ref={dialog}
      className="dshdb-dialog"
      aria-labelledby="dshdb-title"
      onCancel={(event) => {
        event.preventDefault();
        if (confirmation && !busy) setConfirmation(undefined);
        else navigate({ close: true });
      }}
    >
      <header className="dshdb-header">
        <div>
          <h1 id="dshdb-title">数据库连接</h1>
          <p>连接数据库，让 Agent 在你的授权范围内读取数据</p>
        </div>
        <button
          className="dshdb-icon-button"
          type="button"
          aria-label="关闭数据库管理"
          disabled={!!busy || !!confirmation}
          onClick={() => navigate({ close: true })}
        >
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </header>
      <div className="dshdb-body">
        <aside className="dshdb-aside">
          <div className="dshdb-list-heading">
            <span>连接</span>
            <span>{connections.length}</span>
          </div>
          <div className="dshdb-mobile-picker">
            <label className="dshdb-sr-only" htmlFor="dshdb-connection-select">
              选择连接
            </label>
            <select
              id="dshdb-connection-select"
              value={selected ?? ''}
              disabled={locked}
              onChange={(e) => navigate({ id: e.target.value || undefined })}
            >
              <option value="">新建连接</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{engines[c.engine].label} · {statusLabel(c.status)}）
                </option>
              ))}
            </select>
          </div>
          <button
            className="dshdb-button dshdb-add"
            type="button"
            aria-label="新建连接"
            disabled={locked}
            onClick={() => navigate({})}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>新建连接</span>
          </button>
          <button
            className="dshdb-icon-button dshdb-mobile-refresh"
            type="button"
            aria-label="刷新列表"
            title="刷新列表"
            disabled={!!busy || !!confirmation}
            onClick={() => navigate({ refresh: true })}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path
                d="M16 9a6 6 0 1 0-1.6 5M16 4v5h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <nav aria-label="数据库连接" className="dshdb-connections">
            {connections.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`dshdb-connection ${selected === c.id ? 'is-selected' : ''}`}
                disabled={locked}
                onClick={() => {
                  if (c.id !== selected) navigate({ id: c.id });
                }}
                aria-current={selected === c.id ? 'true' : undefined}
              >
                <strong title={c.name}>{c.name}</strong>
                <span>
                  <i className={`dshdb-dot ${c.status}`} aria-hidden="true" />
                  {engines[c.engine].label} · {statusLabel(c.status)}
                </span>
              </button>
            ))}
            {loaded && !connections.length && (
              <p className="dshdb-empty">
                还没有连接
                <br />
                填写右侧配置，添加第一个数据库。
              </p>
            )}
          </nav>
          <div className="dshdb-aside-foot">
            <span>{enabledCount} 个连接已启用访问</span>
            <button
              className="dshdb-text-button"
              type="button"
              disabled={!!busy || !!confirmation}
              onClick={() => navigate({ refresh: true })}
            >
              刷新列表
            </button>
          </div>
        </aside>
        <main className="dshdb-main" aria-busy={!!busy}>
          {loaded && (
            <div className="dshdb-context">
              <div className="dshdb-detail-heading">
                <div>
                  <h2>{current?.name ?? '新建连接'}</h2>
                  <p>{engines[draft.engine].label}</p>
                </div>
                {current && (
                  <div className="dshdb-access-control">
                    <div>
                      <span className="dshdb-access-label">Agent 访问</span>
                      <span className="dshdb-access-status" id="dshdb-access-status">
                        <i className={`dshdb-dot ${current.status}`} aria-hidden="true" />
                        {statusLabel(current.status)}
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Agent 访问"
                      aria-describedby="dshdb-access-status dshdb-tool-help"
                      aria-checked={current.enabled}
                      className="dshdb-switch"
                      disabled={locked || (dirty && !current.enabled)}
                      onClick={toggle}
                    >
                      <span />
                    </button>
                  </div>
                )}
              </div>
              {current && (
                <p
                  id="dshdb-tool-help"
                  className={`dshdb-access-help ${accessError ? 'error' : ''}`}
                  role={accessError ? 'alert' : 'status'}
                  aria-atomic="true"
                >
                  {changingAccess
                    ? busy
                    : (accessNotice?.error && accessNotice.text) ||
                      current.error ||
                      (dirty
                        ? current.enabled
                          ? '修改尚未保存；Agent 仍使用已保存的配置，可随时关闭访问。'
                          : '请先保存或取消修改，再开启访问。'
                        : accessNotice?.text || '开关立即生效，使用已保存的配置与授权。')}
                </p>
              )}
              {current && (
                <div className="dshdb-view-tabs" role="tablist" aria-label="连接详情">
                  {views.map((item, index) => (
                    <button
                      key={item.id}
                      ref={(element) => {
                        tabButtons.current[index] = element;
                      }}
                      type="button"
                      role="tab"
                      id={`dshdb-tab-${item.id}`}
                      aria-controls={`dshdb-panel-${item.id}`}
                      aria-selected={view === item.id}
                      tabIndex={view === item.id ? 0 : -1}
                      disabled={locked}
                      onClick={() => switchView(item.id)}
                      onKeyDown={(event) => {
                        const next =
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? views.length - 1
                              : event.key === 'ArrowRight'
                                ? (index + 1) % views.length
                                : event.key === 'ArrowLeft'
                                  ? (index + views.length - 1) % views.length
                                  : undefined;
                        if (next === undefined) return;
                        event.preventDefault();
                        switchView(views[next]!.id);
                        tabButtons.current[next]?.focus();
                      }}
                    >
                      {item.label}
                      {item.id === 'settings' && dirty && (
                        <span className="dshdb-draft-dot" aria-label="有未保存的修改" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div ref={scroller} className="dshdb-editor">
            {!loaded ? (
              <p className="dshdb-loading">{busy || '连接列表未加载，请刷新列表重试。'}</p>
            ) : (
              <>
                <div
                  role={current ? 'tabpanel' : undefined}
                  id="dshdb-panel-settings"
                  aria-labelledby={current ? 'dshdb-tab-settings' : undefined}
                  hidden={view !== 'settings'}
                >
                  <form
                    ref={form}
                    id="dshdb-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      save();
                    }}
                    onInvalidCapture={(event) => {
                      let parent = (event.target as HTMLElement).parentElement;
                      while (parent && parent !== form.current) {
                        if (parent instanceof HTMLDetailsElement) parent.open = true;
                        parent = parent.parentElement;
                      }
                    }}
                  >
                    <section
                      className="dshdb-settings-section"
                      aria-labelledby="dshdb-connection-heading"
                    >
                      <div className="dshdb-settings-heading">
                        <h3 id="dshdb-connection-heading">连接信息</h3>
                        <nav className="dshdb-section-links" aria-label="设置页内导航">
                          <button
                            type="button"
                            className="dshdb-text-button dshdb-link"
                            disabled={locked}
                            onClick={() => focusSection('checks')}
                          >
                            连接检查
                          </button>
                          <button
                            type="button"
                            className="dshdb-text-button dshdb-link"
                            disabled={locked}
                            onClick={() => focusSection('access')}
                          >
                            授权规则
                          </button>
                        </nav>
                      </div>
                      {!current && (
                        <p className="dshdb-field-help">
                          填写基本信息即可保存，也可先测试。保存后再开启 Agent 访问。
                        </p>
                      )}
                      <ConnectionForm
                        key={selected ?? 'new'}
                        draft={draft}
                        current={current}
                        disabled={locked || !!checking}
                        change={change}
                      />
                    </section>
                    <section
                      className="dshdb-settings-section dshdb-checks"
                      aria-labelledby="dshdb-check-heading"
                    >
                      <h3 id="dshdb-check-heading" ref={checkHeading} tabIndex={-1}>
                        连接检查
                      </h3>
                      <div className="dshdb-check-options">
                        <div>
                          <button
                            type="button"
                            className="dshdb-button"
                            disabled={locked || !!checking}
                            onClick={() => void runCheck('test')}
                          >
                            测试当前配置
                          </button>
                          <p className="dshdb-field-help">
                            使用当前填写的信息，检查能否连接；不会保存或开启访问。
                          </p>
                        </div>
                        {current && (
                          <div>
                            <button
                              type="button"
                              className="dshdb-text-button dshdb-link"
                              disabled={locked || dirty || !!checking}
                              onClick={() => void runCheck('diagnose')}
                            >
                              诊断已保存连接
                            </button>
                            <p className="dshdb-field-help">
                              使用已保存的信息，进一步排查连接和结构访问权限。
                              {dirty ? '请先保存或取消修改。' : ''}
                            </p>
                          </div>
                        )}
                      </div>
                      {checking && (
                        <div className="dshdb-check-progress" role="status">
                          <span>
                            {checking === 'test' ? '正在测试当前配置…' : '正在诊断已保存连接…'}
                          </span>
                          <button
                            type="button"
                            className="dshdb-text-button"
                            onClick={() => cancelCheck()}
                          >
                            取消{checking === 'test' ? '测试' : '诊断'}
                          </button>
                        </div>
                      )}
                      {checkResult && (
                        <div className={`dshdb-check-result ${checkResult.error ? 'error' : ''}`}>
                          <p role={checkResult.error ? 'alert' : 'status'}>{checkResult.text}</p>
                          {checkResult.trace && (
                            <details className="dshdb-trace">
                              <summary>诊断详情</summary>
                              <CallDetails record={checkResult.trace} />
                            </details>
                          )}
                          {current && (
                            <button
                              type="button"
                              className="dshdb-text-button dshdb-link"
                              disabled={locked}
                              onClick={() => switchView('activity')}
                            >
                              查看调用记录
                            </button>
                          )}
                        </div>
                      )}
                    </section>
                    <section
                      className="dshdb-settings-section dshdb-access"
                      aria-labelledby="dshdb-access-heading"
                    >
                      <h3 id="dshdb-access-heading" ref={accessHeading} tabIndex={-1}>
                        授权规则
                      </h3>
                      {!current && (
                        <p className="dshdb-field-help">保存后可开启 Agent 访问，默认关闭。</p>
                      )}
                      <p className="dshdb-field-help" id="dshdb-access-scope">
                        {current ? '已保存的授权：' : '待保存的授权：'}
                        {(current?.effectivePolicy ?? draft.policy).access === 'sessions'
                          ? '指定会话及其子 Agent'
                          : '当前 DSH 的所有会话'}
                        ，
                        {(current?.effectivePolicy ?? draft.policy).mode === 'metadata'
                          ? '仅查看结构'
                          : '结构发现与只读查询'}
                        。
                        {current && dirty
                          ? current.enabled
                            ? '修改保存前仍按已保存的配置运行，可随时停用。'
                            : '请先保存或取消修改，再开启访问。'
                          : ''}
                      </p>
                      <details
                        key={`policy-${selected ?? 'new'}`}
                        className="dshdb-disclosure"
                        open={policyOpen}
                        onToggle={(event) => setPolicyOpen(event.currentTarget.open)}
                      >
                        <summary>
                          授权范围与调用限额<span>保存后生效</span>
                        </summary>
                        <PolicyForm
                          draft={draft}
                          current={current}
                          disabled={locked || !!checking}
                          active={policyOpen && view === 'settings'}
                          change={change}
                        />
                      </details>
                      {current && (
                        <details key={current.id} className="dshdb-tool-details">
                          <summary>如何在对话中使用</summary>
                          <p>
                            在对话中说：“使用「{current.name}」查看有哪些
                            {current.engine === 'mongodb' ? '集合' : '表'}。”
                          </p>
                          <code>{current.inspectToolName}</code>
                          {current.effectivePolicy?.mode !== 'metadata' && (
                            <code>{current.toolName}</code>
                          )}
                        </details>
                      )}
                    </section>
                  </form>
                  {current && (
                    <div className="dshdb-settings-end">
                      <button
                        className="dshdb-text-button danger"
                        type="button"
                        disabled={locked}
                        onClick={() => setConfirmation({ kind: 'delete' })}
                      >
                        删除连接
                      </button>
                      <span className="dshdb-field-help">
                        仅移除此连接配置，不删除数据库中的数据。
                      </span>
                    </div>
                  )}
                </div>
                {current && (
                  <div
                    role="tabpanel"
                    id="dshdb-panel-activity"
                    aria-labelledby="dshdb-tab-activity"
                    hidden={view !== 'activity'}
                  >
                    {view === 'activity' && (
                      <Activity
                        key={current.id}
                        connection={current}
                        disabled={locked}
                        onSettings={() => switchView('settings')}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          {(view === 'settings' ||
            confirmation ||
            dirty ||
            (busy && !changingAccess) ||
            notice) && (
            <footer className="dshdb-footer">
              {confirmation ? (
                <div
                  className="dshdb-confirm"
                  role="alert"
                  aria-label={confirmation.kind === 'delete' ? '确认删除连接' : '未保存的修改'}
                >
                  <p>
                    {confirmation.kind === 'delete'
                      ? `删除「${current?.name}」并撤销查询工具？数据库中的数据不会删除。`
                      : '修改尚未保存，是否放弃？'}
                  </p>
                  {notice?.error && <p className="dshdb-tool-error">{notice.text}</p>}
                  <div className="dshdb-actions">
                    <button
                      ref={cancel}
                      className="dshdb-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => {
                        if (confirmation.kind === 'discard') {
                          setView('settings');
                          scroller.current?.scrollTo({ top: 0 });
                        }
                        setConfirmation(undefined);
                      }}
                    >
                      {confirmation.kind === 'delete' ? '取消' : '继续编辑'}
                    </button>
                    <button
                      className="dshdb-button danger"
                      type="button"
                      disabled={!!busy}
                      onClick={() => {
                        if (confirmation.kind === 'delete') remove();
                        else navigate(confirmation.destination, true);
                      }}
                    >
                      {busy || (confirmation.kind === 'delete' ? '确认删除' : '放弃修改')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="dshdb-footer-content">
                  <div
                    className={`dshdb-feedback ${busy && !changingAccess ? 'pending' : notice?.error ? 'error' : notice ? 'success' : ''}`}
                    role={notice?.error ? 'alert' : 'status'}
                    aria-live={notice?.error ? 'assertive' : 'polite'}
                    aria-atomic="true"
                  >
                    {(changingAccess ? '' : busy) ||
                      notice?.text ||
                      (dirty
                        ? view === 'activity'
                          ? '有未保存的连接设置；查看记录不会保存这些修改。'
                          : '有未保存的修改'
                        : current
                          ? '配置已保存'
                          : '保存后可开启 Agent 访问。')}
                  </div>
                  {view === 'activity' ? (
                    dirty && (
                      <button
                        type="button"
                        className="dshdb-button"
                        disabled={locked}
                        onClick={() => switchView('settings')}
                      >
                        返回连接设置
                      </button>
                    )
                  ) : (
                    <div className="dshdb-actions">
                      {dirty && (
                        <button
                          className="dshdb-text-button dshdb-reset"
                          type="button"
                          disabled={locked}
                          onClick={() => navigate({ id: selected })}
                        >
                          取消修改
                        </button>
                      )}
                      <button
                        className="dshdb-button primary"
                        type="submit"
                        form="dshdb-form"
                        disabled={locked || !!checking || (!!current && !dirty)}
                      >
                        {busy === '正在保存连接…' ? '保存中…' : current ? '保存修改' : '保存连接'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </footer>
          )}
        </main>
      </div>
    </dialog>
  );
}
