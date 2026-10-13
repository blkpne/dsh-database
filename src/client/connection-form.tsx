import React, { useEffect, useState } from 'react';
import type { Connection, Draft } from './model';
import { engines } from '../engines.js';
import type { Engine } from '../engines.js';

export function ConnectionForm({
  draft,
  current,
  disabled,
  change,
}: {
  draft: Draft;
  current?: Connection;
  disabled: boolean;
  change: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  // Drafts never contain the stored credential; only this edit's input can be revealed.
  const canRevealPassword = draft.password.length > 0 && !draft.clearPassword;
  const passwordVisible = canRevealPassword && showPassword && !disabled;
  const passwordHelp = draft.clearPassword
    ? '保存后将清空密码。'
    : current?.hasPassword && canRevealPassword
      ? '保存后将更新密码。'
      : '';
  useEffect(() => {
    setShowPassword(false);
  }, [current?.id, current?.revision, canRevealPassword, draft.clearPassword, disabled]);

  return (
    <fieldset disabled={disabled} className="dshdb-fields">
      <legend className="dshdb-sr-only">数据库连接配置</legend>
      {!current && (
        <label className="full">
          数据库类型
          <select value={draft.engine} onChange={(e) => change('engine', e.target.value as Engine)}>
            {Object.entries(engines).map(([value, engine]) => (
              <option key={value} value={value}>
                {engine.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        连接名称
        <input
          required
          maxLength={80}
          autoFocus={!current}
          autoComplete="off"
          value={draft.name}
          onChange={(e) => change('name', e.target.value)}
          placeholder="例如：业务数据库"
        />
      </label>
      <label>
        {draft.engine === 'oracle' ? '服务名（Service Name）' : '数据库名称'}{' '}
        {!engines[draft.engine].databaseRequired && <span className="dshdb-optional">可选</span>}
        <input
          maxLength={128}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required={engines[draft.engine].databaseRequired}
          value={draft.database}
          onChange={(e) => change('database', e.target.value)}
          placeholder={
            draft.engine === 'oracle'
              ? '例如：FREEPDB1'
              : draft.engine === 'sqlserver'
                ? '留空使用 master'
                : engines[draft.engine].databaseRequired
                  ? '填写要查询的数据库'
                  : '留空可跨库查询'
          }
        />
      </label>
      <div className="dshdb-host-row">
        <label>
          主机地址
          <input
            required
            maxLength={253}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draft.host}
            onChange={(e) => change('host', e.target.value)}
            placeholder="localhost"
          />
        </label>
        <label>
          端口
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            required
            disabled={draft.mongoSrv}
            value={draft.port}
            onChange={(e) => change('port', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
      </div>
      <label>
        用户名 {draft.engine === 'mongodb' && <span className="dshdb-optional">可选</span>}
        <input
          required={draft.engine !== 'mongodb'}
          maxLength={128}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={draft.user}
          onChange={(e) => change('user', e.target.value)}
          placeholder="数据库账户"
        />
      </label>
      <div className="dshdb-password-field">
        <label htmlFor="dshdb-password">密码</label>
        <div className={`dshdb-password-control${canRevealPassword ? ' has-value' : ''}`}>
          <input
            id="dshdb-password"
            type={passwordVisible ? 'text' : 'password'}
            maxLength={4096}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={draft.password}
            disabled={draft.clearPassword}
            aria-describedby={passwordHelp ? 'dshdb-password-help' : undefined}
            onChange={(e) => change('password', e.target.value)}
            placeholder={
              draft.clearPassword
                ? ''
                : current?.hasPassword
                  ? '已保存，留空不修改'
                  : '输入数据库密码'
            }
          />
          {canRevealPassword && (
            <button
              className="dshdb-icon-button dshdb-password-toggle"
              type="button"
              aria-label={passwordVisible ? '隐藏本次输入的密码' : '显示本次输入的密码'}
              title={passwordVisible ? '隐藏本次输入的密码' : '显示本次输入的密码'}
              aria-controls="dshdb-password"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
                {passwordVisible && <path d="m3 3 18 18" />}
              </svg>
            </button>
          )}
        </div>
        {passwordHelp && (
          <p
            className={`dshdb-field-help${draft.clearPassword ? ' danger' : ''}`}
            id="dshdb-password-help"
            role="status"
          >
            {passwordHelp}
          </p>
        )}
      </div>
      <label className="full">
        连接安全
        <select
          value={draft.tls ? 'tls' : 'plaintext'}
          disabled={draft.mongoSrv}
          onChange={(e) => change('tls', e.target.value === 'tls')}
        >
          <option value="tls">TLS 加密并验证服务器身份（推荐）</option>
          <option value="plaintext">明文连接（仅限可信的隔离网络）</option>
        </select>
        <span className="dshdb-field-help">
          {draft.tls
            ? '证书必须受信任并匹配主机地址；验证失败时不会降级为明文。'
            : '此连接不要求传输加密，凭据和数据可能暴露。请仅用于明确允许明文的环境。'}
        </span>
      </label>
      <details className="dshdb-advanced full">
        <summary>
          高级设置<span>连接选项与查询限制</span>
        </summary>
        {draft.engine === 'mongodb' && (
          <>
            <div className="dshdb-limit-grid">
              <label>
                认证数据库
                <input
                  maxLength={128}
                  value={draft.authSource}
                  placeholder="admin"
                  onChange={(e) => change('authSource', e.target.value)}
                />
              </label>
              <label>
                副本集名称 <span className="dshdb-optional">可选</span>
                <input
                  maxLength={128}
                  value={draft.replicaSet}
                  onChange={(e) => change('replicaSet', e.target.value)}
                />
              </label>
            </div>
            <div className="dshdb-options">
              <label>
                <input
                  type="checkbox"
                  checked={draft.mongoSrv}
                  onChange={(e) => change('mongoSrv', e.target.checked)}
                />
                使用 SRV 域名（例如 Atlas，自动开启 TLS）
              </label>
            </div>
          </>
        )}
        {draft.engine === 'sqlserver' && (
          <p className="dshdb-field-help">
            使用 SQL Server 身份验证及只读账户；精确小数和金额列需在查询中转换为字符串。
          </p>
        )}
        <div className="dshdb-limit-grid">
          <label>
            最大查询行数
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={5000}
              required
              value={draft.maxRows}
              onChange={(e) =>
                change('maxRows', e.target.value === '' ? '' : Number(e.target.value))
              }
            />
          </label>
          <label>
            超时（毫秒）
            <input
              type="number"
              inputMode="numeric"
              min={100}
              max={60000}
              required
              value={draft.timeoutMs}
              onChange={(e) =>
                change('timeoutMs', e.target.value === '' ? '' : Number(e.target.value))
              }
            />
          </label>
        </div>
        {current?.hasPassword && (
          <div className="dshdb-options">
            <label>
              <input
                type="checkbox"
                checked={draft.clearPassword}
                onChange={(e) => {
                  change('clearPassword', e.target.checked);
                  if (e.target.checked) change('password', '');
                }}
              />
              清空已保存密码
            </label>
          </div>
        )}
      </details>
    </fieldset>
  );
}
