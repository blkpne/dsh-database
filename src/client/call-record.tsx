import React from 'react';
import type { Trace } from '../observability.js';
import { safeError } from '../errors.js';

export const outcome: Record<Trace['outcome'], string> = {
  running: '进行中',
  success: '成功',
  denied: '已拒绝',
  error: '失败',
  busy: '额度或并发已满',
  timeout: '超时',
  canceled: '已取消',
  interrupted: '中断，结果未知',
};
const phases: Record<string, string> = {
  config: '配置校验',
  policy: '访问策略与额度',
  validation: '输入与只读校验',
  credentials: '读取凭据',
  'credentials-ready': '凭据已就绪',
  'driver-load': '加载驱动',
  'driver-ready': '驱动已就绪',
  'connect-auth': '连接与认证',
  'readonly-setup': '建立只读事务',
  execute: '执行',
  cleanup: '结束本次调用',
  'cleanup-failed': '驱动清理未确认',
  'probe-ok': '探测成功',
  'metadata-permissions': '检查结构发现权限',
  'diagnostic-complete': '诊断完成',
  'mcp-dispatch': '工具分发',
};

export function CallDetails({ record }: { record: Trace }) {
  return (
    <>
      <p>
        {new Date(record.startedAt).toLocaleString()} · 配置版本 {record.revision}
        {record.code ? ` · ${record.code}` : ''}
      </p>
      {record.code && <p>{safeError({ code: record.code }).message}</p>}
      <dl>
        <dt>请求编号</dt>
        <dd>
          <code>{record.requestId}</code>
        </dd>
        {record.callId && (
          <>
            <dt>宿主调用</dt>
            <dd>
              <code>{record.callId}</code>
            </dd>
          </>
        )}
        {record.agentId && (
          <>
            <dt>会话</dt>
            <dd>
              <code>{record.agentId}</code>
            </dd>
          </>
        )}
      </dl>
      <ol>
        {record.stages.map((item, i) => (
          <li key={i}>
            {phases[item.name] ?? item.name} <span>{item.atMs} ms</span>
          </li>
        ))}
      </ol>
      <p>
        取消请求：{record.cancelRequested ? '已发送' : '无'}；本次驱动连接：
        {record.driverClosed ? '已结束清理' : '未建立或未确认'}；服务端终止：
        {record.serverTermination === 'confirmed'
          ? '已确认'
          : record.serverTermination === 'unknown'
            ? '未知'
            : '未请求'}
        。
      </p>
      {record.operation !== 'diagnose' && record.operation !== 'test' && (
        <p>
          宿主最终结果：{record.finalHostOutcome ? '已记录' : '尚未确认'}
          {record.cacheHit ? ' · 元数据缓存命中' : ''}
        </p>
      )}
    </>
  );
}
