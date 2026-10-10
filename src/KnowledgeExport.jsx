import { useState } from 'react';
import { api } from './api';

// Lives outside the selection toolbar so a focus change cannot discard a send attempt.
export default function KnowledgeExport({ draft, onClose, notify }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError('');
    const payload = attempt || { requestId: crypto.randomUUID(), documentId: draft.documentId,
      page: draft.page, rects: draft.rects, quote: draft.quote || '', comment,
      ...(draft.preview ? { image: draft.preview } : {}) };
    setAttempt(payload);
    try {
      await api('/integrations/knowledge/export', { method: 'POST', body: JSON.stringify(payload) });
      onClose();
      notify('已发送到知识库；工作台打开后会自动接收。', 'success');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const onKeyDown = e => {
    e.stopPropagation();
    if (e.key === 'Tab') {
      const items = [...e.currentTarget.querySelectorAll('button:not(:disabled),textarea:not(:disabled)')];
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  return <div className="modal-backdrop" onPointerDown={e => e.stopPropagation()} onKeyDown={onKeyDown}>
    <section className="annotation-modal" role="dialog" aria-modal="true" aria-label="发送到知识库">
      <div className="modal-heading"><h2>留给下一次理解 <small>第 {draft.page} 页</small></h2>
        <button disabled={busy} onClick={onClose}>放弃本次发送</button></div>
      {draft.preview ? <figure className="region-preview"><img src={draft.preview} alt="原始选区" /></figure> : <blockquote>{draft.quote}</blockquote>}
      <label htmlFor="knowledge-comment">你的想法（可选）</label>
      <textarea id="knowledge-comment" autoFocus value={comment} disabled={busy || Boolean(attempt)} maxLength={20000} onChange={e => setComment(e.target.value)} />
      {error && <p className="inline-error" role="alert">{error} 可按原内容重试；请求标识保持不变。</p>}
      <div className="modal-footer"><p>保留原图和来源，不会调用 AI。</p>
        <button className="primary-button" disabled={busy} onClick={send}>{busy ? '正在保存…' : attempt ? '重试发送' : '发送到知识库'}</button></div>
    </section>
  </div>;
}
