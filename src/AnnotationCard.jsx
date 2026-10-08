import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Pencil, Trash2, ScanLine } from 'lucide-react';

export default function AnnotationCard({ annotation, drafts, onJump, onUpdate, onDelete, onReload }) {
  const initial = useRef(drafts.edit(annotation));
  const [editing, setEditing] = useState(Boolean(initial.current));
  const [comment, setComment] = useState(initial.current?.comment ?? annotation.comment);
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const draft = drafts.edit(annotation);
  const change = value => {
    setComment(value); setError('');
    const base = drafts.edit(annotation) || drafts.editDraft(annotation, value);
    // Equality with an old base is still an edit: an unacknowledged request
    // (including one owned by an unmounted card) may already have changed it.
    // Only acknowledged saves or explicit discard clear a recovery draft.
    drafts.write({ ...base, comment: value });
  };
  const discard = () => {
    const value = drafts.edit(annotation);
    if (value) drafts.clear(value);
    setComment(annotation.comment); setEditing(false); setError(''); setConflicted(false);
  };
  const save = async () => {
    if (busy) return;
    const snapshot = drafts.write(drafts.edit(annotation) || drafts.editDraft(annotation, comment));
    setBusy(true); setError('');
    try {
      const next = await onUpdate(annotation.documentId, annotation.id, { comment: snapshot.comment, color: snapshot.color, expectedAnnotationUpdatedAt: snapshot.baseUpdatedAt });
      const retained = drafts.edit(annotation);
      if (retained?.generation === snapshot.generation) {
        drafts.clear(snapshot);
        if (alive.current) { setComment(next.comment); setEditing(false); setConflicted(false); }
      } else if (retained && retained.baseUpdatedAt === snapshot.baseUpdatedAt) {
        // Continued typing is based on our just acknowledged save, and must
        // remain recoverable even when this card has since been unmounted.
        drafts.write({ ...retained, baseUpdatedAt: next.updatedAt, baseComment: next.comment, baseColor: next.color });
      }
    } catch (failure) {
      if (alive.current) { if (failure.status === 409) setConflicted(true); setError(failure.status === 409 ? '批注已在其他窗口更新，你的草稿仍在这里。请载入最新评论并手动合并。' : '保存失败，草稿已保留。'); }
    } finally { if (alive.current) setBusy(false); }
  };
  const reload = async () => {
    setBusy(true);
    try {
      const next = await onReload(annotation.documentId, annotation.id);
      const retained = drafts.edit(annotation);
      if (retained) drafts.clear(retained, { archive: true });
      if (alive.current) { setComment(next.comment); setEditing(false); setError(''); setConflicted(false); }
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusy(false); }
  };
  return <article data-annotation-id={annotation.id} className={`annotation-card border-${annotation.color}`}>
    <div className="annotation-top"><button className="page-link" onClick={() => onJump(annotation)}>第 {annotation.page} 页 <ArrowUpRight size={12}/></button><div><button className="icon-button small" disabled={busy} aria-label="编辑批注" onClick={() => { setEditing(!editing); setComment(drafts.edit(annotation)?.comment ?? annotation.comment); }}><Pencil size={13}/></button><button className="icon-button small" disabled={busy} aria-label="删除批注" onClick={() => setConfirm(true)}><Trash2 size={13}/></button></div></div>
    {annotation.kind === 'region' ? <button className="region-card-link" aria-label="框选区域" onClick={() => onJump(annotation)}><ScanLine size={16}/><span>框选区域<small>回到页面查看标记</small></span><ArrowUpRight size={14}/></button> : <blockquote onClick={() => onJump(annotation)}>{annotation.quote}</blockquote>}
    {editing ? <div className="annotation-edit"><textarea aria-label="编辑批注内容" value={comment} maxLength={20000} onChange={event => change(event.target.value)}/>{draft && <p className="draft-hint">评论草稿保留在当前浏览器，尚未保存到文献库。</p>}{error && <p role="alert" className="inline-error">{error}</p>}<div className="button-row"><button className="text-button" disabled={busy} onClick={() => setEditing(false)}>取消</button>{draft && <button className="text-button" disabled={busy} onClick={discard}>放弃草稿</button>}<button disabled={busy} className="mini-primary" onClick={save}>保存</button></div>{conflicted && <button className="text-button" disabled={busy} onClick={reload}>载入最新评论，保留草稿</button>}</div> : <><p className="annotation-comment">{annotation.comment || (annotation.kind === 'region' ? '仅标记区域，暂无评论' : '仅高亮，暂无评论')}</p>{draft && <button className="text-button" onClick={() => { setComment(draft.comment); setEditing(true); }}>继续编辑评论草稿</button>}</>}
    {confirm && <div className="delete-confirm">删除这条批注？<button className="text-button" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button className="text-button danger" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await onDelete(annotation.documentId, annotation.id); const value = drafts.edit(annotation); if (value) drafts.clear(value); if (alive.current) setConfirm(false); }
      catch { if (alive.current) setError('删除结果未确认，草稿仍保留。请重新打开文献核对。'); }
      finally { if (alive.current) setBusy(false); }
    }}>删除</button>{error && <p role="alert" className="inline-error">{error}</p>}</div>}
  </article>;
}
