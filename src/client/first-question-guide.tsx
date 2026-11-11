import React, { useEffect, useRef, useState } from 'react';
import type { Connection } from './model';
import { firstQuestion, firstQuestionBlock, QuestionCopy } from './first-question';

export function FirstQuestionGuide({
  connection,
  connections,
  dirty,
  disabled,
  onConversation,
}: {
  connection: Connection;
  connections: readonly Connection[];
  dirty: boolean;
  disabled: boolean;
  onConversation: () => void;
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

  function copyQuestion(returnToConversation: boolean) {
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
        if (returnToConversation) onConversation();
      },
      () => {
        setCopying(undefined);
        setFeedback({
          key,
          error: true,
          text: '未能复制。请手动复制示例，再返回获授权的对话。',
        });
        example.current?.focus();
        example.current?.select();
      },
    );
  }

  return (
    <section className="dshdb-first-question" aria-labelledby="dshdb-first-question-heading">
      <h3 id="dshdb-first-question-heading">开始第一次只读对话</h3>
      {blocked ? (
        <p className="dshdb-field-help">{blocked}</p>
      ) : (
        <>
          <p className="dshdb-field-help">
            {scoped
              ? '仅限已授权的会话。复制后，请选择已授权的会话并粘贴。'
              : '复制后返回对话，粘贴并确认发送；也可先点击“新建会话”。'}
            不会自动发送，也不会替换已有输入。
          </p>
          <label className="dshdb-sr-only" htmlFor="dshdb-first-question">
            首问示例
          </label>
          <textarea id="dshdb-first-question" ref={example} value={text} readOnly rows={3} />
          <div className="dshdb-question-actions">
            <button
              type="button"
              className="dshdb-button primary"
              disabled={disabled || copying === key}
              onClick={() => copyQuestion(!scoped)}
            >
              {copying === key ? '正在复制…' : scoped ? '复制首问' : '复制首问并返回对话'}
            </button>
            {!scoped && (
              <button
                type="button"
                className="dshdb-text-button"
                disabled={disabled || copying === key}
                onClick={() => copyQuestion(false)}
              >
                仅复制
              </button>
            )}
            <button
              type="button"
              className="dshdb-text-button"
              disabled={disabled || copying === key}
              onClick={onConversation}
            >
              返回对话
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
        连接测试只检查数据库，模型需另行配置。首次使用请打开侧栏的“设置 → 模型”配置 API 密钥。
        本页不检测模型是否就绪；若对话提示缺少模型凭据，请到该处检查。
      </p>
    </section>
  );
}
