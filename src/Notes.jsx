import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Check, LoaderCircle, Save, AlertCircle } from 'lucide-react';
import { mergeNotes, MAX_NOTE_LENGTH } from '../shared/notes.mjs';
import { api } from './api.js';

const noteText = document => mergeNotes(document.notesZh || '', document.notesEn || '');
const draftSession = crypto.randomUUID();
const legacyDraftKey = id => `paperdesk-draft-${id}`;
const draftKey = id => `paperdesk-draft-${id}-${draftSession}`;
const draftPointer = id => `paperdesk-draft-slot-${id}`;
function readDraft(id) {
  try {
    const pointer = sessionStorage.getItem(draftPointer(id));
    const keys = [draftKey(id), ...(pointer && pointer !== 'saved' ? [pointer] : []), ...(pointer === 'saved' ? [] : [legacyDraftKey(id)])];
    for (const key of keys) {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (value && typeof value.notesZh === 'string' && typeof value.notesEn === 'string') return { text: noteText(value), baseRevision: value.baseRevision, key };
    }
    return null;
  } catch { return null; }
}
function writeDraft(id, text, baseRevision) {
  localStorage.setItem(draftKey(id), JSON.stringify({ notesZh: text, notesEn: '', baseRevision, updatedAt: new Date().toISOString() }));
  sessionStorage.setItem(draftPointer(id), draftKey(id));
}
function clearDraft(id, snapshot) {
  const owned = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
  if (owned && noteText(owned) === snapshot) localStorage.removeItem(draftKey(id));
  // A reload or duplicated tab may still refer to an older slot. Keep that
  // slot recoverable; this tab records that its own editor is now saved.
  sessionStorage.setItem(draftPointer(id), 'saved');
  const legacy = JSON.parse(localStorage.getItem(legacyDraftKey(id)) || 'null');
  if (legacy && noteText(legacy) === snapshot) localStorage.removeItem(legacyDraftKey(id));
}
function readPreserved(id) {
  const entries = [];
  try {
    const legacy = JSON.parse(localStorage.getItem(`paperdesk-preserved-drafts-${id}`) || '[]');
    if (Array.isArray(legacy)) legacy.forEach((entry, index) => { if (typeof entry?.text === 'string') entries.push({ ...entry, key: `legacy-${index}` }); });
  } catch { /* A damaged legacy entry must not hide independent archives. */ }
  try {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(`paperdesk-preserved-draft-${id}-`))) {
      try { const entry = JSON.parse(localStorage.getItem(key)); if (typeof entry?.text === 'string') entries.push({ ...entry, key }); } catch {}
    }
  } catch {}
  return entries.sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')) || a.key.localeCompare(b.key));
}
function readHistoricalDrafts(id) {
  const entries = [];
  try {
    for (const key of Object.keys(localStorage).filter(key => key === legacyDraftKey(id) || key.startsWith(`${legacyDraftKey(id)}-`))) {
      try {
        const entry = JSON.parse(localStorage.getItem(key));
        if (typeof entry?.notesZh === 'string' && typeof entry?.notesEn === 'string') entries.push({ key, text: noteText(entry), updatedAt: entry.updatedAt });
      } catch {}
    }
  } catch {}
  return entries.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.key.localeCompare(b.key));
}
async function requestDocument(id, body) {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, body ? {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || (response.status === 409 ? '已保存的笔记有新版本，草稿已保留。' : '笔记保存失败'));
    error.status = response.status;
    throw error;
  }
  return result.document;
}

const Notes = forwardRef(function Notes({ document, onSaved, onError, onDirtyChange, storageMode = 'library' }, ref) {
  const currentDocument = useRef(document); currentDocument.current = document;
  const draft = useRef(readDraft(document.id));
  const [text, setText] = useState(draft.current?.text ?? noteText(document));
  const [status, setStatus] = useState(draft.current ? 'pending' : 'saved');
  const [conflict, setConflict] = useState(false), [recovering, setRecovering] = useState(false);
  const [storageError, setStorageError] = useState(false), [preserved, setPreserved] = useState(() => readPreserved(document.id));
  const [historical, setHistorical] = useState(() => readHistoricalDrafts(document.id));
  const latest = useRef(text), saved = useRef(noteText(document));
  const serverRevision = useRef(draft.current?.baseRevision || document.notesRevision);
  const timer = useRef(null), queue = useRef(Promise.resolve()), alive = useRef(true), revision = useRef(0);
  const scheduled = useRef(Boolean(draft.current));
  const pending = useRef(0), conflicted = useRef(false), incoming = useRef(null), recoveringRef = useRef(false);
  const vaultConflictPreserved = useRef(false);
  const callbacks = useRef({ onSaved, onDirtyChange }); callbacks.current = { onSaved, onDirtyChange };
  const dirty = () => scheduled.current || pending.current > 0 || latest.current !== saved.current || conflicted.current;
  const report = () => callbacks.current.onDirtyChange?.(document.id, dirty());
  const preserveVaultConflict = () => {
    if (storageMode !== 'vault' || vaultConflictPreserved.current) return;
    vaultConflictPreserved.current = true;
    const snapshot = latest.current;
    void api(`/documents/${encodeURIComponent(document.id)}/vault-conflict`, { method: 'POST', body: JSON.stringify({ text: snapshot }) })
      .then(result => { if (result.preserved !== true) throw new Error('仓库未确认保留冲突副本。'); })
      .catch(error => { if (alive.current) onError(`冲突草稿仍在本机，仓库副本未确认保存：${error.message}`); });
  };
  const markConflict = (preserve = true) => {
    if (!preserve) vaultConflictPreserved.current = true;
    conflicted.current = true; scheduled.current = false; clearTimeout(timer.current);
    if (alive.current) { setConflict(true); setStatus('error'); }
    if (preserve) preserveVaultConflict();
    report();
  };
  const acceptExternal = next => {
    if (!next || next.notesRevision === serverRevision.current) return;
    if (pending.current || recoveringRef.current) { incoming.current = next; return; }
    if (dirty()) { incoming.current = next; markConflict(); return; }
    serverRevision.current = next.notesRevision;
    latest.current = saved.current = noteText(next);
    if (alive.current) { setText(latest.current); setStatus('saved'); }
    report();
  };
  const save = () => {
    clearTimeout(timer.current); scheduled.current = false;
    const snapshot = latest.current, atRevision = revision.current;
    pending.current++; report();
    if (alive.current && !conflicted.current) setStatus('saving');
    const work = queue.current.catch(() => {}).then(async () => {
      if (conflicted.current) throw new Error('已保存的笔记有新版本，请先处理保留的草稿。');
      // Compare after older writes settle: B -> A must still write A after B.
      // Merged semantic equality keeps merely opening legacy notes read-only.
      if (snapshot !== saved.current) {
        const expectedRevision = serverRevision.current;
        const next = await requestDocument(document.id, { notesZh: snapshot, notesEn: '', expectedNotesRevision: expectedRevision });
        saved.current = snapshot; serverRevision.current = next.notesRevision;
        callbacks.current.onSaved(next, expectedRevision);
        if (incoming.current?.notesRevision === next.notesRevision) incoming.current = null;
        // If typing continued during this request, its recovery draft now builds
        // on our acknowledged save. Do not modify a different tab's local draft.
        try {
          const retained = readDraft(document.id);
          if (revision.current !== atRevision && retained?.text === latest.current && retained.baseRevision === expectedRevision) {
            writeDraft(document.id, latest.current, next.notesRevision);
          }
        } catch { if (alive.current) setStorageError(true); }
      }
      if (revision.current === atRevision) {
        try { if (readDraft(document.id)?.text === snapshot) clearDraft(document.id, snapshot); } catch {}
        if (alive.current) setStatus('saved');
      }
    }).catch(error => {
      // A rejected vault PATCH already preserves a file copy on the server.
      if (error.status === 409) markConflict(false);
      else if (alive.current && revision.current === atRevision) setStatus('error');
      throw error;
    }).finally(() => {
      pending.current--;
      if (!pending.current && incoming.current) {
        const next = incoming.current; incoming.current = null; acceptExternal(next);
      }
      report();
    });
    queue.current = work;
    return work;
  };
  const saveRef = useRef(save); saveRef.current = save;
  useImperativeHandle(ref, () => ({ flush: () => saveRef.current(), isDirty: () => dirty() }));
  useEffect(() => { acceptExternal(document); }, [document.notesRevision]);
  useEffect(() => { if (conflicted.current) preserveVaultConflict(); }, [storageMode]);
  useEffect(() => {
    const refreshDrafts = event => {
      if (event.key === null || event.key?.includes(document.id)) {
        setPreserved(readPreserved(document.id)); setHistorical(readHistoricalDrafts(document.id));
      }
    };
    window.addEventListener('storage', refreshDrafts);
    return () => window.removeEventListener('storage', refreshDrafts);
  }, [document.id]);
  useEffect(() => {
    alive.current = true; report();
    if (draft.current) {
      if ((draft.current.baseRevision && draft.current.baseRevision !== document.notesRevision) || (!draft.current.baseRevision && draft.current.text !== noteText(document))) markConflict();
      else timer.current = setTimeout(() => saveRef.current().catch(() => {}), 200);
    }
    const warn = event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => {
      alive.current = false; window.removeEventListener('beforeunload', warn); clearTimeout(timer.current);
      // A conflicted draft remains local. It must never become an unconditional write.
      if (!conflicted.current && latest.current !== saved.current) saveRef.current().catch(() => {});
    };
  }, []);
  const change = value => {
    revision.current++; latest.current = value; scheduled.current = !conflicted.current; setText(value);
    if (!conflicted.current) setStatus('pending');
    try {
      writeDraft(document.id, value, serverRevision.current);
      setStorageError(false);
    } catch { setStorageError(true); }
    report(); clearTimeout(timer.current);
    if (!conflicted.current) timer.current = setTimeout(() => saveRef.current().catch(() => {}), 650);
  };
  const loadSaved = async () => {
    if (recoveringRef.current) return;
    recoveringRef.current = true; setRecovering(true); clearTimeout(timer.current);
    try {
      await queue.current.catch(() => {});
      let expectedRevision, next;
      for (let attempt = 0; attempt < 3; attempt++) {
        expectedRevision = currentDocument.current.notesRevision;
        next = await requestDocument(document.id);
        if (currentDocument.current.notesRevision === expectedRevision) break;
        next = null;
      }
      if (!next) throw new Error('已保存的笔记正在更新，请稍后重试。');
      // Persist the archive before replacing the editor. Storage failure leaves it intact.
      // One independent key per action prevents cross-tab read/modify/write loss.
      localStorage.setItem(`paperdesk-preserved-draft-${document.id}-${crypto.randomUUID()}`, JSON.stringify({ text: latest.current, savedAt: new Date().toISOString(), baseRevision: serverRevision.current }));
      clearDraft(document.id, latest.current);
      revision.current++; latest.current = saved.current = noteText(next); serverRevision.current = next.notesRevision;
      incoming.current = null; conflicted.current = false;
      vaultConflictPreserved.current = false;
      setPreserved(readPreserved(document.id)); setHistorical(readHistoricalDrafts(document.id)); setText(latest.current); setConflict(false); setStatus('saved'); setStorageError(false);
      callbacks.current.onSaved(next, expectedRevision); report();
    } catch (error) { onError(`草稿仍在编辑区：${error.message}`); }
    finally { recoveringRef.current = false; setRecovering(false); }
  };
  const visibleHistory = historical.filter((entry, index, entries) => entry.key !== draftKey(document.id)
    && entry.key !== draft.current?.key && entry.text !== text && !preserved.some(archive => archive.text === entry.text)
    && entries.findIndex(other => other.text === entry.text) === index);
  return <div className="notes-body">
    <h2>笔记</h2><p className="notes-intro">{storageMode === 'vault' ? '支持 Markdown，自动保存到 Obsidian 仓库。' : '支持 Markdown，自动保存到本机。'}</p>
    {draft.current && <div className="draft-hint">已恢复本机草稿。</div>}
    {conflict && <div className="notes-conflict" role="alert"><p>已保存的笔记有新版本。你的草稿仍在这里，自动保存已暂停。</p><button className="text-button" disabled={recovering} onClick={loadSaved}>{recovering ? '正在保留草稿…' : '保留草稿并载入已保存笔记'}</button></div>}
    <label className="notes-field"><textarea aria-label="笔记" maxLength={MAX_NOTE_LENGTH} spellCheck="false" value={text} disabled={recovering} onChange={event => change(event.target.value)} placeholder="记录你的想法…"/><span className="word-count">{text.length} 字符</span></label>
    <div className={`save-row ${status === 'error' ? 'save-error' : ''}`}><span role="status">{status === 'saved' ? <Check size={14}/> : status === 'saving' ? <LoaderCircle size={14} className="spin"/> : status === 'error' ? <AlertCircle size={14}/> : <span className="status-dot"/>}{({ saved: storageMode === 'vault' ? '已保存到 Obsidian 仓库' : '已保存到本机', saving: '正在保存…', pending: '等待保存…', error: conflict ? '版本冲突，草稿已保留' : '保存失败，草稿已保留' })[status]}</span><button className="text-button" disabled={conflict || recovering} onClick={() => save().catch(error => onError(error.message))}><Save size={14}/> 保存</button></div>
    {storageError && <p role="alert" className="inline-error">浏览器草稿存储已满，请点击保存并确认成功后再关闭页面。</p>}
    {preserved.length > 0 && <details className="preserved-drafts"><summary>查看保留的草稿（{preserved.length}）</summary>{preserved.map((entry, index) => <label key={entry.key}>草稿 {index + 1}<textarea aria-label={`保留的笔记草稿 ${index + 1}`} readOnly value={entry.text}/></label>)}</details>}
    {visibleHistory.length > 0 && <details className="historical-drafts"><summary>查看其他窗口与历史草稿（{visibleHistory.length}）</summary><p>这里只供查看和复制，不会载入编辑区或改动原草稿。需要恢复时，请核对后复制到笔记中。</p>{visibleHistory.map((entry, index) => <label key={entry.key}>其他窗口或历史草稿 {index + 1}<textarea aria-label={`其他窗口或历史草稿 ${index + 1}`} readOnly value={entry.text}/></label>)}</details>}
  </div>;
});
export default Notes;
