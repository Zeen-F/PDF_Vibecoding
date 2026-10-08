import React, { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { api } from './api.js';
import './vault.css';

const fmtSize = size => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
const directoryOf = file => file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '仓库根目录';

export default function VaultPdfPicker({ open, onClose, onChoose, busy }) {
  const [files, setFiles] = useState([]), [query, setQuery] = useState(''), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [truncated, setTruncated] = useState(false);
  const dialog = useRef(null), search = useRef(null), opener = useRef(null), controller = useRef(null), sequence = useRef(0), choosing = useRef(false);
  const refresh = async () => {
    const version = ++sequence.current;
    controller.current?.abort(); controller.current = new AbortController();
    setLoading(true); setError('');
    try {
      const result = await api('/vault/pdfs', { signal: controller.current.signal });
      if (version !== sequence.current) return;
      setFiles(result.files); setTruncated(result.truncated === true);
    } catch (error) {
      if (error.name !== 'AbortError' && version === sequence.current) setError(error.message);
    } finally { if (version === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    if (!open) return;
    opener.current = window.document.activeElement;
    setFiles([]); setQuery(''); setTruncated(false); setError('');
    dialog.current?.showModal(); search.current?.focus(); void refresh();
    return () => {
      ++sequence.current; controller.current?.abort();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [open]);
  const choose = async file => {
    if (busy || choosing.current) return;
    choosing.current = true; setError('');
    try { await onChoose(file.path); }
    catch (error) { setError(error.message); }
    finally { choosing.current = false; }
  };
  if (!open) return null;
  const filtered = files.filter(file => `${file.name}\n${file.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <dialog ref={dialog} className="vault-dialog vault-pdf-dialog" aria-label="选择 Obsidian PDF" aria-modal="true"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="vault-heading"><h2><FolderOpen size={19}/> 选择 Obsidian PDF</h2><button className="icon-button" aria-label="关闭 PDF 选择器" disabled={busy} onClick={onClose}><X size={19}/></button></div>
    <p className="vault-description">PDF 留在 Obsidian 原目录。列表只扫描文件，选定后才关联阅读笔记与批注。</p>
    <div className="vault-pdf-search"><Search size={16}/><input ref={search} aria-label="搜索 Obsidian PDF" placeholder="搜索文件名或原目录" value={query} disabled={busy} onChange={event => setQuery(event.target.value)}/><button className="icon-button" aria-label="重新扫描 Obsidian PDF" title="重新扫描" disabled={loading || busy} onClick={refresh}><RefreshCw size={15}/></button></div>
    {error && <p className="vault-error" role="alert">{error}</p>}
    {busy && <p className="vault-pdf-status" role="status"><LoaderCircle size={15} className="spin"/> 正在关联并打开 PDF…</p>}
    <div className="vault-pdf-list" aria-label="Obsidian PDF 列表" aria-busy={loading || busy}>
      {loading ? <p className="vault-pdf-status" role="status"><LoaderCircle size={15} className="spin"/> 正在扫描仓库中的 PDF…</p>
        : filtered.length ? filtered.map(file => <button key={file.path} className="vault-pdf-item" aria-label={`打开 PDF：${file.path}`} disabled={busy} onClick={() => void choose(file)}><FileText size={18}/><span className="vault-pdf-details"><strong>{file.name}</strong><small>{directoryOf(file)}</small><span>{fmtSize(file.byteSize)}{file.documentId ? ' · 已关联' : ''}</span></span><span className="vault-pdf-open">打开</span></button>)
          : <p className="vault-pdf-empty">{query.trim() ? '没有符合搜索条件的 PDF。' : error ? '文件列表暂时无法读取，请重新扫描。' : '仓库中还没有 PDF。先把 PDF 放进 Obsidian，再重新扫描。'}</p>}
    </div>
    {truncated && <p className="vault-pdf-limit">PDF 数量较多，当前仅列出部分文件。</p>}
    <div className="vault-picker-footer"><span>{loading ? '扫描中' : `${filtered.length} 个 PDF`}</span><button className="text-button" disabled={busy} onClick={onClose}>取消</button></div>
  </dialog>;
}
