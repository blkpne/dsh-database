import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelSession, panelDraftConflict } from './panel-session';
import { PolicyForm } from './policy-form';
import { FeedbackLink } from './feedback-link';
import { Activity } from './activity';
import { CallDetails, outcome } from './call-record';
import type { Observatory, Trace } from '../observability.js';
import { safeError } from '../errors.js';
import { ConnectionProbe } from './probe';
import { ConnectionForm } from './connection-form';
import { FirstQuestionGuide } from './first-question-guide';
import { FirstConnectionHint } from './first-question';
import {
  emptyDraft,
  hasChanges,
  statusLabel,
  toDraft,
  switchEngine,
  savedConnection,
  connectionPayload,
  changePasswordMode,
  isConnectionList,
} from './model';
import type { Connection, Draft, SaveResponse } from './model';
import { engines } from '../engines.js';
import type { Engine } from '../engines.js';

type View = 'settings' | 'activity';
type Check = 'test' | 'diagnose';
type CheckResult = {
  text: string;
  state: 'success' | 'error' | 'stale' | 'canceled';
  trace?: Trace;
};
type Snapshot = ReturnType<Observatory['snapshot']>;
const views = [
  { id: 'settings', label: '连接设置' },
  { id: 'activity', label: '调用记录' },
] as const;
type Destination = { id?: string; refresh?: boolean };
type Confirmation = { kind: 'discard'; destination: Destination } | { kind: 'delete' };
type ListResponse = { connections: Connection[] };
class ApiFailure extends Error {
  constructor(
    message: string,
    readonly data?: {
      code?: string;
      committed?: boolean;
      connectionId?: string;
      connections?: Connection[];
    },
  ) {
    super(message);
  }
}

export function Manager({ session }: { session: PanelSession }) {
  const [restored] = useState(() => session.read());
  const panel = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const controller = useRef(new AbortController());
  const activeOperation = useRef(false);
  const pendingMutation = useRef(false);
  const operationFocus = useRef<HTMLElement>();
  const probe = useRef(new ConnectionProbe());
  const [checking, setChecking] = useState<Check>();
  const [checkResult, setCheckResult] = useState<CheckResult | undefined>(
    restored?.checking
      ? { state: 'canceled', text: '离开数据库面板时已取消等待检查结果，请重新测试。' }
      : undefined,
  );
  const [connections, setConnections] = useState<Connection[]>(restored?.connections ?? []);
  const [selected, setSelected] = useState<string | undefined>(restored?.selected);
  const [draft, setDraft] = useState<Draft>(() => restored?.draft ?? emptyDraft());
  const [policyOpen, setPolicyOpen] = useState(restored?.policyOpen ?? false);
  const [draftConflict, setDraftConflict] = useState(restored?.conflict ?? false);
  // Only the first successful creation in an initially empty manager offers onboarding.
  const guide = useRef(new FirstConnectionHint());
  const [guideConnectionId, setGuideConnectionId] = useState<string>();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<View>(restored?.view ?? 'settings');
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('正在读取连接…');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [accessNotice, setAccessNotice] = useState<{ text: string; error: boolean }>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const current = connections.find((c) => c.id === selected);
  const dirty = draftConflict || hasChanges(draft, current);
  const locked = !!busy || !!confirmation || !loaded;

  useEffect(() => {
    if (busy || !operationFocus.current) return;
    const target = operationFocus.current;
    operationFocus.current = undefined;
    if (target.isConnected && !target.matches(':disabled') && panel.current?.contains(target))
      target.focus({ preventScroll: true });
    else detailHeading.current?.focus({ preventScroll: true });
  }, [busy]);

  // The host unmounts keyed panels on navigation. Keep only committed React state
  // in this activation's memory; no browser storage, URL or Host persistence.
  useLayoutEffect(() => {
    if (!loaded) return;
    session.write({
      connections,
      selected,
      draft,
      view,
      policyOpen,
      dirty,
      conflict: draftConflict,
      pendingMutation: pendingMutation.current,
      checking: !!checking,
      scrollTop: scroller.current?.scrollTop ?? 0,
    });
  });

  useEffect(() => {
    const lifecycle = new AbortController();
    controller.current = lifecycle;
    let frame = 0;
    panel.current?.focus({ preventScroll: true });
    void request<ListResponse>({ action: 'list' })
      .then((data) => {
        if (lifecycle.signal.aborted) return;
        setConnections(data.connections);
        guide.current.observeExisting(data.connections.length);
        if (restored?.dirty || restored?.pendingMutation) {
          setDraftConflict(panelDraftConflict(restored, data.connections));
        } else {
          const connection =
            data.connections.find((item) => item.id === restored?.selected) ??
            (restored ? undefined : data.connections[0]);
          select(connection);
          if (restored) {
            setPolicyOpen(restored.policyOpen);
            if (connection) setView(restored.view);
          }
          if (restored?.checking)
            setCheckResult({
              state: 'canceled',
              text: '离开数据库面板时已取消等待检查结果，请重新测试。',
            });
        }
        setLoaded(true);
        frame = requestAnimationFrame(() => {
          if (!lifecycle.signal.aborted)
            scroller.current?.scrollTo({ top: restored?.scrollTop ?? 0 });
        });
      })
      .catch(report)
      .finally(() => {
        if (!lifecycle.signal.aborted) setBusy('');
      });
    return () => {
      cancelAnimationFrame(frame);
      probe.current.cancel();
      lifecycle.abort();
      // Never return focus to the old entry: the user may have selected another panel/session.
    };
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const previousFocus = document.activeElement;
    confirmDialog.current?.showModal();
    cancel.current?.focus();
    return () => {
      confirmDialog.current?.close();
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        panel.current?.contains(previousFocus)
      )
        previousFocus.focus();
      else form.current?.querySelector('input')?.focus();
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
    if (response.status === 401)
      throw new ApiFailure('登录已失效，请刷新 DSH 页面。', { code: 'HOST_UNAUTHORIZED' });
    if (response.status === 403)
      throw new ApiFailure('宿主拒绝此请求，请使用 DSH 本机页面。', { code: 'HOST_FORBIDDEN' });
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('DSH 未返回有效响应，请刷新列表重试。');
    const data = await response.json();
    if (!data || typeof data.ok !== 'boolean')
      throw new Error('DSH 未返回有效响应，请刷新列表核对。');
    if (!response.ok || !data.ok)
      throw new ApiFailure(data.message || '操作失败，请稍后重试。', data);
    if (
      ['list', 'save', 'toggle', 'remove'].includes(String(payload.action)) &&
      !isConnectionList(data.connections)
    )
      throw new Error('未收到完整连接列表，请刷新列表核对。');
    if (payload.action === 'save' || payload.action === 'toggle') {
      const id = payload.action === 'save' ? data.connectionId : payload.id;
      if (
        (payload.id && id !== payload.id) ||
        !data.connections.some((item: Connection) => item.id === id)
      )
        throw new Error('未收到本次操作的连接记录，请刷新列表核对。');
    }
    if (
      payload.action === 'remove' &&
      data.connections.some((item: Connection) => item.id === payload.id)
    )
      throw new Error('尚未确认连接是否已移除，请刷新列表核对。');
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
    pendingMutation.current = !!mutation;
    if (document.activeElement instanceof HTMLElement)
      operationFocus.current = document.activeElement;
    setBusy(label);
    setNotice(undefined);
    setAccessNotice(undefined);
    try {
      await operation();
    } catch (error) {
      // A completed HTTP request can still have an unknown write outcome. Keep that
      // guard after the error and across navigation, not just while fetch is pending.
      const failure = error instanceof ApiFailure ? error.data : undefined;
      let confirmed =
        failure?.committed !== true &&
        [
          'INVALID_INPUT',
          'DUPLICATE_NAME',
          'LIMIT',
          'BUSY',
          'CONFLICT',
          'NOT_FOUND',
          'TOO_LARGE',
          'CLOSED',
          'HOST_UNAUTHORIZED',
          'HOST_FORBIDDEN',
        ].includes(failure?.code ?? '');
      if (failure?.committed === true && isConnectionList(failure.connections)) {
        const latest = failure.connections;
        const saved = latest.find((c) => c?.id === failure.connectionId);
        const sameTarget = !selected || failure.connectionId === selected;
        if (sameTarget && (mutation === 'remove' ? !!selected && !saved : !!saved)) {
          setConnections(latest);
          if (mutation === 'save') select(saved);
          if (mutation === 'remove') select(latest[0]);
          confirmed = true;
        }
      }
      if (mutation && !confirmed) setDraftConflict(true);
      report(error, mutation === 'toggle' ? 'access' : 'general');
    } finally {
      activeOperation.current = false;
      pendingMutation.current = false;
      if (!controller.current.signal.aborted) setBusy('');
    }
  }

  function select(connection?: Connection) {
    // Reset native user-invalid state as well as controlled values on explicit selection/reset.
    form.current?.reset();
    setDraftConflict(false);
    setGuideConnectionId(undefined);
    setPolicyOpen(false);
    setCheckResult(undefined);
    setView('settings');
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
    setGuideConnectionId(undefined);
    setView(next);
    tabButtons.current[views.findIndex((item) => item.id === next)]?.focus();
    scroller.current?.scrollTo({ top: 0 });
  }

  function navigate(destination: Destination, force = false) {
    if (busy || activeOperation.current) return;
    cancelCheck(false);
    if (dirty && !force) {
      setConfirmation({ kind: 'discard', destination });
      return;
    }
    setConfirmation(undefined);
    if (destination.refresh) {
      void act('正在刷新列表…', async () => {
        const data = await request<ListResponse>({ action: 'list' });
        setConnections(data.connections);
        guide.current.observeExisting(data.connections.length);
        select(data.connections.find((c) => c.id === selected) ?? data.connections[0]);
        setLoaded(true);
        setNotice({ error: false, text: '连接列表已刷新。' });
      });
    } else select(connections.find((c) => c.id === destination.id));
  }

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    const interrupted = probe.current.cancel();
    setChecking(undefined);
    setCheckResult((result) =>
      result || interrupted
        ? {
            state: 'stale',
            text: '配置已更改，请重新测试。',
          }
        : undefined,
    );
    setAccessNotice(undefined);
    setDraft((d) =>
      key === 'passwordMode'
        ? changePasswordMode(d, value as Draft['passwordMode'])
        : key === 'engine'
          ? switchEngine(d, value as Engine)
          : key === 'mongoSrv' && value
            ? { ...d, mongoSrv: true, port: 27017, tls: true }
            : { ...d, [key]: value },
    );
    setNotice(undefined);
  }

  function save() {
    if (locked || checking || draftConflict || (current && !dirty)) return;
    void act(
      '正在保存连接…',
      async () => {
        const data = await request<SaveResponse>({
          action: 'save',
          connection: connectionPayload(draft),
          id: selected,
          revision: current?.revision,
        });
        const saved = savedConnection(data);
        const offerGuide = !current && !connections.length && guide.current.claim();
        const keepGuide = guideConnectionId === saved.id;
        setConnections(data.connections);
        select(saved);
        if (offerGuide || keepGuide) {
          setGuideConnectionId(saved.id);
        }
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
    if (!probe.current.cancel()) return;
    if (showResult)
      setCheckResult({
        state: 'canceled',
        text: '已取消等待结果；服务端会处理取消，尚未确认执行是否已停止。',
      });
    setChecking(undefined);
  }

  async function runCheck(kind: Check) {
    if (locked || activeOperation.current) return;
    if (kind === 'diagnose' ? !current || dirty : !form.current?.reportValidity()) return;
    const own = probe.current.start();
    if (!own) return;
    setChecking(kind);
    setCheckResult(undefined);
    try {
      if (kind === 'diagnose' && current) {
        const data = await request<{ trace: Trace; observations: Snapshot }>(
          { action: 'diagnose', id: current.id, revision: current.revision },
          own.signal,
        );
        if (!probe.current.owns(own) || controller.current.signal.aborted) return;
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
          state: trace.outcome === 'success' ? 'success' : 'error',
          trace,
          text:
            trace.outcome === 'success'
              ? '诊断通过：已保存的配置可连接，并完成结构访问检查。不代表所有业务表均可读取。'
              : `诊断${outcome[trace.outcome]}。${trace.code ? safeError({ code: trace.code }).message : '请展开诊断详情定位失败阶段。'}`,
        });
      } else {
        const data = await request<{ result: { rows: unknown[][] } }>(
          { action: 'test', connection: connectionPayload(draft), id: selected },
          own.signal,
        );
        if (!probe.current.owns(own) || controller.current.signal.aborted) return;
        if (!Array.isArray(data.result?.rows))
          throw new Error('未收到完整的连接测试结果，请重试。');
        setCheckResult({
          state: 'success',
          text: `当前配置可连接，探测查询成功。${dirty || !current ? '保存后生效。' : ''}不代表所有业务表均可访问。`,
        });
      }
    } catch (error) {
      if (probe.current.owns(own) && !controller.current.signal.aborted)
        setCheckResult({
          state: 'error',
          text: error instanceof Error ? error.message : '连接检查失败，请重试。',
        });
    } finally {
      if (probe.current.finish(own)) {
        setChecking(undefined);
      }
    }
  }

  function toggle() {
    if (!current || locked || draftConflict || (dirty && !current.enabled)) return;
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
    if (!current || activeOperation.current || draftConflict) return;
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
  const shownPolicy = current?.effectivePolicy ?? draft.policy;
  const policyDescription = `${shownPolicy.access === 'sessions' ? '指定会话及其子 Agent' : '当前 DSH 的所有会话'}，${shownPolicy.mode === 'metadata' ? '仅查看结构' : '结构发现与只读查询'}。`;
  const accessError = !changingAccess && !!(accessNotice?.error || current?.error);
  return (
    <section ref={panel} className="dshdb-panel" aria-labelledby="dshdb-title" tabIndex={-1}>
      <header className="dshdb-header">
        <div>
          <h1 id="dshdb-title">数据库连接</h1>
        </div>
        <FeedbackLink />
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
                新建连接后，可测试并保存。
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
        <div className="dshdb-main" aria-busy={!!busy}>
          <div
            ref={scroller}
            className="dshdb-content"
            onScroll={(event) => session.scroll(event.currentTarget.scrollTop)}
          >
            {draftConflict && (
              <p className="dshdb-draft-conflict" role="alert">
                草稿已保留，但已保存的连接发生变化，或上次操作结果尚未确认。
                请先刷新列表核对；刷新会询问是否放弃草稿，不会自动重试保存。
              </p>
            )}
            {loaded && (
              <div className="dshdb-context">
                <div className="dshdb-detail-heading">
                  <div>
                    <h2 ref={detailHeading} tabIndex={-1}>
                      {current?.name ?? '新建连接'}
                    </h2>
                    {current && <p>{engines[draft.engine].label}</p>}
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
                        disabled={locked || draftConflict || (dirty && !current.enabled)}
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
                    className={`dshdb-access-help ${accessError ? 'error' : ''} ${current.enabled && !changingAccess && !accessNotice && !current.error && !dirty ? 'dshdb-sr-only' : ''}`}
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
                          : accessNotice?.text ||
                            (current.enabled
                              ? '开关立即生效，使用已保存的配置与授权。'
                              : view === 'settings'
                                ? '确认下方授权规则后，可在此开启访问。'
                                : '确认连接设置中的授权规则后，可在此开启访问。'))}
                  </p>
                )}
                {current && guideConnectionId === current.id && (
                  <FirstQuestionGuide
                    key={current.id}
                    connection={current}
                    connections={connections}
                    dirty={dirty}
                    disabled={locked || !!checking}
                    onDismiss={() => {
                      setGuideConnectionId(undefined);
                      detailHeading.current?.focus();
                    }}
                  />
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
            <div className="dshdb-editor">
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
                        setNotice({
                          error: true,
                          text: '请检查标记的字段：必填项不能为空，地址和数值需符合格式要求。',
                        });
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
                        <h3 id="dshdb-connection-heading" className="dshdb-sr-only">
                          连接信息
                        </h3>
                        {!current && (
                          <p className="dshdb-field-help">* 为必填；密码按认证方式填写。</p>
                        )}
                        <ConnectionForm
                          autoFocus={!restored}
                          key={selected ?? 'new'}
                          draft={draft}
                          current={current}
                          disabled={locked}
                          change={change}
                        />
                      </section>
                      {current && (
                        <section
                          className="dshdb-settings-section dshdb-checks"
                          aria-label="连接诊断"
                        >
                          <button
                            type="button"
                            className="dshdb-button dshdb-secondary"
                            disabled={locked || dirty}
                            aria-disabled={!!checking || undefined}
                            onClick={() => void runCheck('diagnose')}
                          >
                            诊断已保存连接
                          </button>
                          <p className="dshdb-field-help">
                            进一步检查结构访问权限。
                            {dirty ? '请先保存或取消修改。' : '不修改配置或授权。'}
                          </p>
                          {checkResult?.trace && (
                            <details className="dshdb-trace">
                              <summary>诊断详情</summary>
                              <CallDetails record={checkResult.trace} />
                            </details>
                          )}
                        </section>
                      )}
                      <section
                        className={`dshdb-settings-section dshdb-access${current ? '' : ' is-new'}`}
                        aria-labelledby="dshdb-access-heading"
                      >
                        <h3
                          id="dshdb-access-heading"
                          className={current ? undefined : 'dshdb-sr-only'}
                        >
                          授权规则
                        </h3>
                        {current && (
                          <p className="dshdb-field-help" id="dshdb-access-scope">
                            已保存的授权：{policyDescription}
                            {dirty
                              ? current.enabled
                                ? '修改保存前仍按已保存的配置运行，可随时停用。'
                                : '请先保存或取消修改，再开启访问。'
                              : ''}
                          </p>
                        )}
                        {current && (
                          <details className="dshdb-access-disclosure">
                            <summary>访问范围与数据使用</summary>
                            <p className="dshdb-field-help">
                              开启后按已保存的授权生效：
                              {(current.effectivePolicy ?? current.policy)?.access === 'sessions'
                                ? '指定会话及其子 Agent'
                                : '当前 DSH 的所有会话'}
                              ，
                              {(current.effectivePolicy ?? current.policy)?.mode === 'metadata'
                                ? '仅结构发现'
                                : '结构发现与只读查询'}
                              。工具返回的结构与数据会进入对话，并可能发送给所选模型服务。请先确认数据库账户权限和模型服务设置；停用不能撤回已返回的数据。
                            </p>
                          </details>
                        )}
                        <details
                          key={`policy-${selected ?? 'new'}`}
                          className="dshdb-disclosure"
                          open={policyOpen}
                          onToggle={(event) => setPolicyOpen(event.currentTarget.open)}
                        >
                          <summary>
                            {current ? '授权范围与调用限额' : '授权规则'}
                            <span>{current ? '保存后生效' : '可选 · 保存后生效'}</span>
                          </summary>
                          {!current && (
                            <p className="dshdb-field-help" id="dshdb-access-scope">
                              待保存的授权：{policyDescription}
                            </p>
                          )}
                          <PolicyForm
                            draft={draft}
                            current={current}
                            disabled={locked}
                            active={policyOpen && view === 'settings'}
                            change={change}
                          />
                        </details>
                        {current && (
                          <details key={current.id} className="dshdb-tool-details">
                            <summary>高级：工具标识与查询建议</summary>
                            {current.effectivePolicy?.mode !== 'metadata' && (
                              <p>
                                确认结构后，再提出具体问题、时间范围和统计口径，优先让 Agent
                                在数据库端汇总，只返回必要结果。
                              </p>
                            )}
                            <code>{current.inspectToolName}</code>
                            {current.effectivePolicy?.mode !== 'metadata' && (
                              <code>{current.toolName}</code>
                            )}
                          </details>
                        )}
                      </section>
                      {current && (
                        <section
                          className="dshdb-settings-section dshdb-management"
                          aria-label="连接管理"
                        >
                          <div>
                            <h3>连接管理</h3>
                            <p className="dshdb-field-help">
                              删除将撤销工具并移除连接配置，数据库中的数据不受影响。
                            </p>
                          </div>
                          <button
                            type="button"
                            className="dshdb-button danger"
                            disabled={locked || draftConflict}
                            onClick={() => {
                              cancelCheck();
                              setConfirmation({ kind: 'delete' });
                            }}
                          >
                            删除连接
                          </button>
                        </section>
                      )}
                    </form>
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
          </div>
          {(view === 'settings' ||
            confirmation ||
            dirty ||
            (busy && !changingAccess) ||
            notice) && (
            <footer className="dshdb-footer">
              {confirmation ? (
                <dialog
                  ref={confirmDialog}
                  className="dshdb-confirm"
                  aria-labelledby="dshdb-confirm-title"
                  onKeyDown={(event) => {
                    if (event.key !== 'Tab') return;
                    const buttons = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        'button:not(:disabled)',
                      ),
                    );
                    const target = event.shiftKey ? buttons.at(-1) : buttons[0];
                    const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
                    if (!buttons.length || document.activeElement === edge) {
                      event.preventDefault();
                      target?.focus();
                    }
                  }}
                  onCancel={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!busy) setConfirmation(undefined);
                  }}
                >
                  <h2 id="dshdb-confirm-title">
                    {confirmation.kind === 'delete' ? '删除连接？' : '放弃未保存的修改？'}
                  </h2>
                  <p>
                    {confirmation.kind === 'delete'
                      ? `将移除「${current?.name}」的配置和已保存密码，并撤销 Agent 工具。数据库中的数据不会删除。${dirty ? '未保存的修改也将丢弃。' : ''}`
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
                      disabled={!!busy || (confirmation.kind === 'delete' && draftConflict)}
                      onClick={() => {
                        if (confirmation.kind === 'delete') remove();
                        else navigate(confirmation.destination, true);
                      }}
                    >
                      {busy || (confirmation.kind === 'delete' ? '确认删除' : '放弃修改')}
                    </button>
                  </div>
                </dialog>
              ) : (
                <>
                  {view === 'settings' && (checking || checkResult) && (
                    <div
                      className={`dshdb-check-banner ${checking ? 'pending' : checkResult?.state}`}
                      role={checkResult?.state === 'error' ? 'alert' : 'status'}
                      aria-atomic="true"
                    >
                      <strong>
                        {checking
                          ? checking === 'test'
                            ? '正在测试连接…'
                            : '正在诊断…'
                          : {
                              success: '✓ 连接检查通过',
                              error: '连接检查失败',
                              stale: '需要重新测试',
                              canceled: '检查已取消',
                            }[checkResult!.state]}
                      </strong>
                      <p>
                        {checking ? '可继续修改配置；修改后将取消本次检查。' : checkResult?.text}
                      </p>
                    </div>
                  )}
                  <div className="dshdb-footer-content">
                    <div
                      className={`dshdb-feedback ${current && !busy && !notice && !dirty ? 'is-quiet' : ''} ${busy && !changingAccess ? 'pending' : notice?.error ? 'error' : notice ? 'success' : ''}`}
                      role={notice?.error ? 'alert' : 'status'}
                      aria-live={notice?.error ? 'assertive' : 'polite'}
                      aria-atomic="true"
                    >
                      {(changingAccess ? '' : busy) ||
                        notice?.text ||
                        (dirty
                          ? view === 'activity'
                            ? '有未保存的连接设置；切换面板仍保留草稿。'
                            : '有未保存的修改；切换面板仍保留草稿'
                          : current
                            ? '配置已保存'
                            : '保存后 Agent 访问默认关闭')}
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
                        {checking ? (
                          <button
                            className="dshdb-button"
                            type="button"
                            onClick={() => cancelCheck()}
                          >
                            取消{checking === 'test' ? '测试' : '诊断'}
                          </button>
                        ) : (
                          <button
                            className="dshdb-button dshdb-test"
                            type="button"
                            disabled={locked}
                            onClick={() => void runCheck('test')}
                          >
                            测试连接
                          </button>
                        )}
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
                          disabled={locked || draftConflict || !!checking || (!!current && !dirty)}
                        >
                          {busy === '正在保存连接…' ? '保存中…' : current ? '保存修改' : '保存连接'}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </footer>
          )}
        </div>
      </div>
    </section>
  );
}
