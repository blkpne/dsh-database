import React, { useEffect, useRef, useState } from 'react';
import type { Connection } from './model';
import { firstQuestion, firstQuestionBlock, QuestionCopy } from './first-question';

export function FirstQuestionGuide({
  connection,
  connections,
  dirty,
  disabled,
  onDismiss,
}: {
  connection: Connection;
  connections: readonly Connection[];
  dirty: boolean;
  disabled: boolean;
  onDismiss: () => void;
}) {
  const copy = useRef(new QuestionCopy());
  const example = useRef<HTMLTextAreaElement>(null);
  const [feedback, setFeedback] = useState<{ key: string; text: string; error?: boolean }>();
  const [copying, setCopying] = useState<string>();
  const blocked = firstQuestionBlock(connection, connections, dirty);
  const scoped = (connection.effectivePolicy ?? connection.policy)?.access === 'sessions';
  const text = firstQuestion(connection);
  const key = JSON.stringify([connection.id, connection.revision, text, blocked, scoped, disabled]);
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => () => copy.current.cancel(), []);
  useEffect(() => {
    copy.current.cancel();
    setCopying(undefined);
  }, [key]);

  function copyQuestion() {
    if (disabled || blocked || copying === key) return;
    setCopying(key);
    setFeedback(undefined);
    void copy.current.run(
      text,
      (value) => navigator.clipboard.writeText(value),
      () => latest.current === key,
      () => {
        setCopying(undefined);
        setFeedback({ key, text: '已复制。请在获授权的对话中粘贴，确认后发送。' });
      },
      () => {
        setCopying(undefined);
        setFeedback({
          key,
          error: true,
          text: '未能复制。已选中示例，可手动复制到获授权的对话。',
        });
        example.current?.focus();
        example.current?.select();
      },
    );
  }

  return (
    <section className="dshdb-first-question" aria-labelledby="dshdb-first-question-heading">
      <div className="dshdb-guide-heading">
        <h3 id="dshdb-first-question-heading">连接已创建，接下来如何使用</h3>
        <button type="button" className="dshdb-text-button" onClick={onDismiss}>
          关闭提示
        </button>
      </div>
      {blocked ? (
        <p className="dshdb-field-help">{blocked}</p>
      ) : (
        <>
          <p className="dshdb-field-help">
            {scoped
              ? '仅限已授权的会话。复制后，请选择已授权的会话并粘贴。'
              : '复制示例，在你选择的对话中粘贴并确认发送。'}
            不会自动发送，也不会替换已有输入。
          </p>
          <label className="dshdb-sr-only" htmlFor="dshdb-first-question">
            首问示例
          </label>
          <textarea id="dshdb-first-question" ref={example} value={text} readOnly rows={3} />
          <div className="dshdb-question-actions">
            <button
              type="button"
              className="dshdb-button"
              disabled={disabled}
              aria-disabled={copying === key || undefined}
              onClick={copyQuestion}
            >
              {copying === key ? '正在复制…' : '复制提示词'}
            </button>
          </div>
          {feedback?.key === key && (
            <p
              className={`dshdb-field-help${feedback.error ? ' danger' : ''}`}
              role={feedback.error ? 'alert' : 'status'}
            >
              {feedback.text}
            </p>
          )}
        </>
      )}
      <p className="dshdb-model-guidance">
        若对话提示缺少模型配置，请在“设置 → 模型”中配置；测试连接只检查数据库。
      </p>
    </section>
  );
}
