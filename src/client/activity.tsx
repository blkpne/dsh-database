import React, { useEffect, useRef, useState } from 'react';
import type { Connection } from './model';
import type { Observatory } from '../observability.js';
import { CallDetails, outcome } from './call-record';

type Snapshot = ReturnType<Observatory['snapshot']>;
export function Activity({
  connection,
  disabled,
  onSettings,
}: {
  connection: Connection;
  disabled: boolean;
  onSettings: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [canceled, setCanceled] = useState(false);
  const controller = useRef<AbortController>();
  const mounted = useRef(true);
  async function load() {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setBusy(true);
    setError('');
    setCanceled(false);
    try {
      const response = await fetch('/api/dsh-database', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'observations',
          id: connection.id,
        }),
        signal: AbortSignal.any([own.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('宿主未返回有效响应，请刷新页面。');
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.message ?? '读取调用记录失败。');
      if (mounted.current && !own.signal.aborted) setSnapshot(value.observations);
    } catch (failure) {
      if (mounted.current && !own.signal.aborted)
        setError(failure instanceof Error ? failure.message : '读取调用记录失败。');
    } finally {
      if (mounted.current && controller.current === own) setBusy(false);
    }
  }
  function cancelLoad() {
    controller.current?.abort();
    setCanceled(true);
  }
  useEffect(() => {
    mounted.current = true;
    setSnapshot(undefined);
    void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [connection.id, connection.revision]);
  return (
    <div className="dshdb-activity" aria-busy={!!busy}>
      <div className="dshdb-records-heading">
        <h3>最近调用</h3>
        <div className="dshdb-diagnostic-actions">
          <button
            type="button"
            className="dshdb-text-button"
            disabled={disabled || !!busy}
            onClick={() => void load()}
          >
            {busy ? '正在刷新…' : '刷新记录'}
          </button>
          {busy && (
            <button type="button" className="dshdb-text-button" onClick={cancelLoad}>
              取消读取
            </button>
          )}
        </div>
      </div>
      <p className="dshdb-field-help">显示最近 50 条记录，不包含查询内容、参数或业务数据。</p>
      {error && (
        <p role="alert" className="dshdb-tool-error">
          {error} 请尝试刷新记录。
        </p>
      )}
      {canceled && !busy && (
        <p role="status" className="dshdb-field-help">
          已取消等待结果。{snapshot ? '以下为上次读取的记录。' : '可点击“刷新记录”重新读取。'}
        </p>
      )}
      {!snapshot && busy && (
        <p role="status" className="dshdb-field-help">
          正在读取调用记录…
        </p>
      )}
      {snapshot && (snapshot.journal.dropped > 0 || snapshot.journal.writeFailures > 0) && (
        <p role="status" className="dshdb-tool-error">
          记录不完整：丢弃 {snapshot.journal.dropped} 次写入，写入失败{' '}
          {snapshot.journal.writeFailures} 次。
        </p>
      )}
      {snapshot && !snapshot.records.length && (
        <div className="dshdb-records-empty">
          <p>暂无调用记录</p>
          <p className="dshdb-field-help">
            {connection.enabled
              ? '在对话中使用此连接后，可在这里查看调用结果。'
              : '开启 Agent 访问并在对话中使用此连接后，可在这里查看调用结果。'}
            连接测试与诊断也会记录在这里。
          </p>
          <button
            type="button"
            className="dshdb-text-button dshdb-link"
            disabled={disabled}
            onClick={onSettings}
          >
            前往连接设置
          </button>
        </div>
      )}
      {snapshot?.records.map((record) => (
        <details className="dshdb-trace" key={record.requestId}>
          <summary>
            <span className="dshdb-trace-main">
              <strong>
                {record.operation === 'test'
                  ? record.draft
                    ? '测试草稿'
                    : '测试连接'
                  : record.operation === 'diagnose'
                    ? '连接诊断'
                    : record.operation === 'inspect'
                      ? '结构发现'
                      : '只读查询'}
              </strong>
              <time dateTime={new Date(record.startedAt).toISOString()}>
                {new Date(record.startedAt).toLocaleString()}
              </time>
            </span>
            <span className="dshdb-trace-result">
              <span className={`dshdb-outcome ${record.outcome}`}>{outcome[record.outcome]}</span>
              <span>{record.durationMs} ms</span>
            </span>
          </summary>
          <CallDetails record={record} />
        </details>
      ))}
      {snapshot && snapshot.records.length > 0 && (
        <details className="dshdb-records-stats">
          <summary>运行统计与保留范围</summary>
          <p className="dshdb-field-help">
            本次读取时进行中的调用：{snapshot.active}；耗时 P50 / P95：{snapshot.p50Ms} /{' '}
            {snapshot.p95Ms} ms。需刷新以获取最新状态。
          </p>
          <p className="dshdb-records-retention dshdb-field-help">
            统计基于保留窗口：最多 2,000 条、8 MiB、7 天。重启时未完成的调用标记为中断。
          </p>
        </details>
      )}
    </div>
  );
}
