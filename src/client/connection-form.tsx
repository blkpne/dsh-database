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
  const passwordHelp =
    draft.passwordMode === 'clear'
      ? '保存后移除已保存的密码；本次测试也将使用空密码。'
      : draft.passwordMode === 'keep'
        ? '已保存。测试和保存均沿用原密码，无需重新输入。'
        : current?.hasPassword
          ? '输入新密码，保存后替换。原密码不会显示在此处。'
          : '密码由 DSH 保存；无密码认证可留空。';
  useEffect(() => {
    setShowPassword(false);
  }, [current?.id, current?.revision, canRevealPassword, draft.passwordMode, disabled]);

  return (
    <fieldset disabled={disabled} className="dshdb-fields">
      <legend className="dshdb-sr-only">数据库连接配置</legend>
      {!current && (
        <label className="full">
          数据库类型{' '}
          <span className="dshdb-required" aria-hidden="true">
            必填
          </span>
          <select value={draft.engine} onChange={(e) => change('engine', e.target.value as Engine)}>
            {Object.entries(engines).map(([value, engine]) => (
              <option key={value} value={value}>
                {engine.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="full dshdb-security">
        <label htmlFor="dshdb-security">
          连接安全{' '}
          <span className="dshdb-required" aria-hidden="true">
            {draft.mongoSrv ? 'SRV 必须启用' : '必选'}
          </span>
        </label>
        <select
          id="dshdb-security"
          required
          aria-describedby="dshdb-security-help"
          value={draft.tls === '' ? '' : draft.tls ? 'tls' : 'plaintext'}
          disabled={draft.mongoSrv}
          onChange={(e) => change('tls', e.target.value === '' ? '' : e.target.value === 'tls')}
        >
          <option value="" disabled>
            请选择：按数据库服务的配置
          </option>
          <option value="tls">TLS 加密 · 验证证书与主机名（推荐）</option>
          <option value="plaintext">不要求加密 · 仅限可信隔离网络</option>
        </select>
        <span className="dshdb-field-help" id="dshdb-security-help">
          {draft.mongoSrv
            ? 'MongoDB SRV 必须使用 TLS；验证证书与主机名，端口由 DNS 决定。'
            : draft.tls === ''
              ? '支持 TLS 的服务推荐选加密；未配置 TLS 的本地服务需明确选择“不要求加密”。'
              : draft.tls
                ? '证书必须受信任并匹配主机地址；验证失败时不会降级为明文。'
                : draft.engine === 'sqlserver'
                  ? '客户端不要求加密；SQL Server 仍可强制加密。请仅用于可信隔离网络。'
                  : '此连接使用明文传输，凭据和数据可能暴露。请仅用于可信隔离网络。'}
        </span>
        {draft.engine === 'oracle' && (
          <span className="dshdb-field-help">TLS 使用 TCPS，请填写服务器的 TCPS 端口。</span>
        )}
      </div>
      <label>
        连接名称{' '}
        <span className="dshdb-required" aria-hidden="true">
          必填
        </span>
        <input
          required
          maxLength={80}
          autoFocus={!current}
          autoComplete="off"
          value={draft.name}
          onChange={(e) => change('name', e.target.value)}
          placeholder="自定义名称，例如：业务分析库"
        />
      </label>
      <label>
        {draft.engine === 'oracle' ? '服务名（Service Name）' : '数据库名称'}{' '}
        <span
          className={engines[draft.engine].databaseRequired ? 'dshdb-required' : 'dshdb-optional'}
          aria-hidden="true"
        >
          {engines[draft.engine].databaseRequired ? '必填' : '可选'}
        </span>
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
          主机地址{' '}
          <span className="dshdb-required" aria-hidden="true">
            必填
          </span>
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
          端口{' '}
          <span className="dshdb-required" aria-hidden="true">
            {draft.mongoSrv ? '自动' : '必填'}
          </span>
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
      <h4 className="dshdb-field-heading full">身份认证</h4>
      <label className="dshdb-user">
        用户名{' '}
        <span
          className={draft.engine === 'mongodb' ? 'dshdb-optional' : 'dshdb-required'}
          aria-hidden="true"
        >
          {draft.engine === 'mongodb' ? '可选' : '必填'}
        </span>
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
        <label htmlFor={current?.hasPassword ? 'dshdb-password-mode' : 'dshdb-password'}>
          密码
        </label>
        {current?.hasPassword && (
          <select
            id="dshdb-password-mode"
            value={draft.passwordMode}
            aria-describedby="dshdb-password-help"
            onChange={(e) => change('passwordMode', e.target.value as Draft['passwordMode'])}
          >
            <option value="keep">保留已保存密码</option>
            <option value="replace">更换密码</option>
            <option value="clear">清空密码</option>
          </select>
        )}
        {draft.passwordMode === 'replace' && (
          <>
            {current?.hasPassword && (
              <label className="dshdb-sr-only" htmlFor="dshdb-password">
                新密码
              </label>
            )}
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
                required={!!current?.hasPassword}
                aria-describedby={passwordHelp ? 'dshdb-password-help' : undefined}
                onChange={(e) => change('password', e.target.value)}
                placeholder={current?.hasPassword ? '输入新密码' : '输入数据库密码'}
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
          </>
        )}
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
      </details>
    </fieldset>
  );
}
