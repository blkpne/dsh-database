import React, { useEffect, useState } from 'react';

export function FeedbackLink() {
  const [english, setEnglish] = useState(() => /^en(?:-|$)/i.test(document.documentElement.lang));
  useEffect(() => {
    // The host reflects its active language on <html>; no settings or credentials are read.
    const update = () => setEnglish(/^en(?:-|$)/i.test(document.documentElement.lang));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    update();
    return () => observer.disconnect();
  }, []);

  const label = english ? 'Feedback' : '意见与反馈';
  const hint = english
    ? 'Opens GitHub in a new tab. Sign in to submit feedback.'
    : '在新标签页打开 GitHub，提交反馈需要登录。';
  return (
    <a
      className="dshdb-feedback-link"
      href="https://github.com/blkpne/dsh-database/issues/new/choose"
      target="_blank"
      rel="noopener noreferrer"
      title={hint}
      aria-label={`${label} — ${hint}`}
    >
      {label}
      <span aria-hidden="true">↗</span>
    </a>
  );
}
