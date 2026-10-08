import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, Search, X, FileText, ArrowUpRight, LockKeyhole, LoaderCircle, Folder, FolderOpen, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { DOCUMENT_DRAG_TYPE, THEMES, THEME_IDS } from '../shared/library.mjs';
import './library.css';

const fmtSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export default function Library({ documents, currentId, loading, importing, query, onQuery, onClearSearch, onImport, onDemo, onOpen, onRefresh, onFolderChange, searchResults, searchCount, searchDocumentIds = [], storageMode = 'library', onChooseVaultPdf, vaultBusy = false, vaultInventory, onVaultPdfOpen, onVaultRetry }) {
  const [folders, setFolders] = useState([]), [filter, setFilter] = useState('all');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [theme, setTheme] = useState('forest'), [pendingTheme, setPendingTheme] = useState(null);
  const [dialog, setDialog] = useState(null), [name, setName] = useState(''), [dropTarget, setDropTarget] = useState(null);
  const dialogRef = useRef(null), dragRef = useRef(null), refreshVersion = useRef(0), mutationRef = useRef(false);
  const themeQueue = useRef(Promise.resolve()), themeVersion = useRef(0), confirmedTheme = useRef('forest'), mounted = useRef(true);
  const load = async () => {
    const version = ++refreshVersion.current, themeAtStart = themeVersion.current;
    const [library] = await Promise.all([api('/library'), onRefresh()]);
    if (!mounted.current || version !== refreshVersion.current) return;
    setFolders(library.folders);
    setFilter(value => value === 'all' || value === 'unfiled' || library.folders.some(folder => folder.id === value) ? value : 'unfiled');
    if (themeAtStart === themeVersion.current && !pendingTheme && THEME_IDS.includes(library.theme)) {
      confirmedTheme.current = library.theme; setTheme(library.theme);
    }
    setReady(true);
  };
  useEffect(() => { mounted.current = true; load().catch(e => setError(e.message)); return () => { mounted.current = false; }; }, []);
  useEffect(() => { window.document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (dialog) dialogRef.current?.showModal(); }, [dialog]);
  const refresh = async () => { if (mutationRef.current) return; setError(''); setBusy(true); try { await themeQueue.current; await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const mutate = async action => {
    if (mutationRef.current) return false;
    mutationRef.current = true; ++refreshVersion.current; setBusy(true); setError('');
    try { await action(); return true; } catch (e) { setError(e.message); return false; }
    finally { mutationRef.current = false; setBusy(false); }
  };
  const chooseTheme = id => {
    const version = ++themeVersion.current;
    setPendingTheme(id); setError('');
    themeQueue.current = themeQueue.current.catch(() => {}).then(async () => {
      try {
        const data = await api('/library/theme', { method: 'PATCH', body: JSON.stringify({ theme: id }) });
        confirmedTheme.current = data.theme;
        if (mounted.current && version === themeVersion.current) setTheme(data.theme);
      } catch (e) {
        if (mounted.current && version === themeVersion.current) { setTheme(confirmedTheme.current); setError(`主题未保存：${e.message}`); }
      } finally { if (mounted.current && version === themeVersion.current) setPendingTheme(null); }
    });
  };
  const move = async (documentId, folderId) => {
    const document = documents.find(item => item.id === documentId);
    if (!document || (folderId !== null && !folders.some(folder => folder.id === folderId)) || (document.folderId ?? null) === folderId) return;
    await mutate(async () => {
      const result = await api(`/documents/${encodeURIComponent(documentId)}/folder`, { method: 'PATCH', body: JSON.stringify({ folderId }) });
      onFolderChange(result.document.id, result.document.folderId);
    });
  };
  const startDrag = (event, documentId) => {
    if (busy) { event.preventDefault(); return; }
    const token = crypto.randomUUID(); dragRef.current = { documentId, token };
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, JSON.stringify(dragRef.current));
  };
  const targetEvents = folderId => ({
    onDragOver: event => {
      if (!event.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)) return;
      event.stopPropagation();
      if (!dragRef.current || busy) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(folderId ?? 'unfiled');
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: event => {
      if (!event.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)) return;
      event.preventDefault(); event.stopPropagation(); setDropTarget(null);
      const source = dragRef.current; dragRef.current = null;
      try { const value = JSON.parse(event.dataTransfer.getData(DOCUMENT_DRAG_TYPE)); if (source && value.token === source.token && value.documentId === source.documentId) void move(source.documentId, folderId); } catch { /* An external or malformed payload is never a document move. */ }
    },
  });
  const closeDialog = () => { if (!mutationRef.current) setDialog(null); };
  const submitFolder = async event => {
    event.preventDefault(); const action = dialog;
    const ok = await mutate(async () => {
      if (action.type === 'delete') {
        await api(`/folders/${action.folder.id}`, { method: 'DELETE' });
        for (const doc of documents.filter(item => item.folderId === action.folder.id)) onFolderChange(doc.id, null);
        setFolders(items => items.filter(item => item.id !== action.folder.id));
        setFilter(value => value === action.folder.id ? 'unfiled' : value);
      } else {
        const result = await api(action.type === 'new' ? '/folders' : `/folders/${action.folder.id}`, { method: action.type === 'new' ? 'POST' : 'PATCH', body: JSON.stringify({ name: name.trim() }) });
        setFolders(items => action.type === 'new' ? [...items, result.folder] : items.map(item => item.id === result.folder.id ? result.folder : item));
      }
    });
    if (ok) setDialog(null);
  };
  const visible = documents.filter(doc => filter === 'all' || (filter === 'unfiled' ? !doc.folderId : doc.folderId === filter));
  const count = id => documents.filter(doc => (doc.folderId ?? null) === id).length;
  const activeFolder = folders.find(folder => folder.id === filter);
  const vault = storageMode === 'vault';
  const sourceFiles = new Map(vault ? (vaultInventory?.files || []).filter(file => file.documentId).map(file => [file.documentId,file]) : []);
  const directory = file => file.path.includes('/') ? file.path.slice(0,file.path.lastIndexOf('/')) : '仓库根目录';
  const unlinked = vault ? (vaultInventory?.files || []).filter(file => file.documentId === null) : [];
  const candidates = query.trim() ? unlinked.filter(file => `${file.name}\n${file.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : filter === 'all' || filter === 'unfiled' ? unlinked : [];
  const linkedMatches = query.trim() && vault ? documents.filter(doc => sourceFiles.has(doc.id) && !searchDocumentIds.includes(doc.id) && `${doc.filename}\n${sourceFiles.get(doc.id).name}\n${sourceFiles.get(doc.id).path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(doc => ({...sourceFiles.get(doc.id),title:doc.title,name:doc.filename || sourceFiles.get(doc.id).name})) : [];
  const candidateRows = [...candidates,...linkedMatches].map(file => <div className="document-row vault-document-row" key={file.path} data-vault-pdf={file.documentId ? undefined : file.path}>
    <button className="document-item vault-document-item" aria-label={`打开 Obsidian PDF：${file.path}`} disabled={vaultBusy} onClick={() => void (file.documentId ? onOpen(file.documentId) : onVaultPdfOpen(file.path))}><FileText size={16} className="vault-document-icon"/><span className="document-details"><b>{file.title || file.name}</b>{file.title && file.title !== file.name && <small className="vault-document-path">{file.name}</small>}<small className="vault-document-path">{directory(file)}</small><small>{fmtSize(file.byteSize)} · {query.trim() ? '文件名 / 路径匹配' : '尚未打开'}</small></span></button>
  </div>);
  return <>
    <a href="#" className="brand" onClick={event => { event.preventDefault(); onQuery(''); setFilter('all'); }}><span className="brand-mark"><BookOpen size={22}/></span><span>纸间<span className="brand-english">PAPERDESK</span></span></a>
    <div className="sidebar-caption">给阅读留一张安静的书桌。</div>
    <button className="import-button" aria-label="导入 PDF" disabled={importing || vaultBusy} onClick={onImport}>{importing ? <LoaderCircle size={17} className="spin"/> : <Plus size={18}/>} {importing ? '正在导入与索引…' : '导入 PDF'} <span aria-hidden="true">↗</span></button>
    {vault && <button className="vault-choose-button" aria-label="选择 Obsidian PDF" disabled={vaultBusy} onClick={onChooseVaultPdf}><FolderOpen size={14}/> 选择 Obsidian PDF <ArrowUpRight size={13}/></button>}
    <div className="search-field"><Search size={16}/><input id="library-search" aria-label="全文搜索" value={query} maxLength={200} onChange={event => onQuery(event.target.value)} placeholder="搜索全文、笔记、批注"/>{query ? <button className="clear-search" aria-label="清空搜索" onClick={onClearSearch}><X size={14}/></button> : <kbd>⌘ K</kbd>}</div>
    <div className="folder-heading"><span>书架</span><div><button aria-label="刷新文献库" title="刷新文献库与主题" disabled={busy || !!pendingTheme} onClick={refresh}><RefreshCw size={13}/></button><button aria-label="新建文件夹" title="新建文件夹" disabled={!ready || busy} onClick={() => { setName(''); setDialog({ type: 'new' }); }}><Plus size={15}/></button></div></div>
    <nav className="folder-list" aria-label="文献文件夹">
      <button className="folder-target" aria-label="全部文献" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); onQuery(''); }}><BookOpen size={14}/><span>全部文献</span><small>{documents.length + unlinked.length}</small></button>
      <button className={`folder-target ${dropTarget === 'unfiled' ? 'drop-target' : ''}`} aria-label="未分类" aria-pressed={filter === 'unfiled'} onClick={() => { setFilter('unfiled'); onQuery(''); }} {...targetEvents(null)}><FileText size={14}/><span>未分类</span><small>{count(null) + unlinked.length}</small></button>
      {folders.map(folder => <div className="folder-row" key={folder.id}><button className={`folder-target ${dropTarget === folder.id ? 'drop-target' : ''}`} aria-label={`文件夹：${folder.name}`} aria-pressed={filter === folder.id} onClick={() => { setFilter(folder.id); onQuery(''); }} {...targetEvents(folder.id)}>{filter === folder.id ? <FolderOpen size={14}/> : <Folder size={14}/>}<span>{folder.name}</span><small>{count(folder.id)}</small></button><div className="folder-actions"><button aria-label={`重命名文件夹：${folder.name}`} disabled={busy} onClick={() => { setName(folder.name); setDialog({ type: 'rename', folder }); }}><Pencil size={11}/></button><button aria-label={`删除文件夹：${folder.name}`} disabled={busy} onClick={() => setDialog({ type: 'delete', folder })}><Trash2 size={11}/></button></div></div>)}
    </nav>
    {error && <p className="library-error" role="alert">{error}</p>}
    {vault && vaultInventory?.error && <div className="library-error vault-inventory-error" role="alert"><span>Obsidian PDF 列表未更新：{vaultInventory.error}{vaultInventory.loaded ? '。当前保留上次列表。' : '。请重试读取。'}</span><button disabled={vaultInventory.loading || vaultBusy} onClick={onVaultRetry}>重试 PDF 列表</button></div>}
    {vault && vaultInventory?.truncated && <p className="vault-inventory-notice">仓库文件较多，当前仅列出部分 PDF。</p>}
    <div className="library-heading"><span>{query.trim() ? '搜索结果 · 全部文献' : activeFolder?.name || (filter === 'unfiled' ? '未分类' : '我的文献')}</span><span>{query.trim() ? searchCount : visible.length + candidates.length}</span></div>
    <nav className="document-list" aria-label="文献库">{loading ? <p className="library-empty">正在打开书桌…</p> : query.trim() ? <>{searchResults}{candidates.length > 0 && <p className="vault-search-caption">文件名与路径匹配 · 打开后可全文搜索</p>}{candidateRows}</> : <>{visible.map((doc, index) => <div className="document-row" key={doc.id} data-document-id={doc.id}>
      <button className={`document-item ${currentId === doc.id ? 'active' : ''}`} disabled={vaultBusy} draggable={!busy && !vaultBusy} onDragStart={event => startDrag(event, doc.id)} onDragEnd={() => { dragRef.current = null; setDropTarget(null); }} onClick={() => onOpen(doc.id)}><span className="document-number">{String(index + 1).padStart(2, '0')}</span><span className="document-details"><b>{doc.title}</b>{vault && <small className="vault-document-path">{doc.filename}</small>}{vault && sourceFiles.has(doc.id) && <small className="vault-document-path">{directory(sourceFiles.get(doc.id))}</small>}<small>{doc.pageCount} 页 <span>·</span> {fmtSize(doc.byteSize)}{!doc.textAvailable ? ' · 扫描件' : ''}</small></span><FileText size={15} className="doc-icon"/></button>
      <label className="document-move"><span>移动到</span><select aria-label={`移动文献：${doc.title}`} value={doc.folderId || ''} disabled={!ready || busy} onChange={event => void move(doc.id, event.target.value || null)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
    </div>)}{candidateRows}{vault && vaultInventory?.loading && <p className="vault-inventory-notice" role="status">正在读取 Obsidian PDF 列表…</p>}{!visible.length && !candidates.length && !vaultInventory?.loading && !(vault && vaultInventory?.error) && <p className="library-empty">{documents.length ? '这里还没有文献。' : '书架还是空的。'}<small>{documents.length ? '将文献拖到上方文件夹，或用“移动到”整理。' : vault ? '导入新的 PDF，或将 PDF 放进 Obsidian 后刷新列表。' : '导入第一篇论文，或打开示例开始体验。'}</small></p>}</>}</nav>
    <div className="sidebar-bottom"><fieldset className="theme-picker"><legend>书桌配色</legend><div>{THEMES.map(item => <button key={item.id} className="theme-choice" data-theme-choice={item.id} aria-label={`主题：${item.label}`} aria-pressed={theme === item.id} disabled={!ready} onClick={() => chooseTheme(item.id)}><span className={`theme-swatch swatch-${item.id}`} aria-hidden="true"/><span>{item.label}</span></button>)}</div><p role="status">{pendingTheme ? `正在保存${THEMES.find(item => item.id === pendingTheme)?.label}…` : '配色随本机文献库保存'}</p></fieldset>{!vault && <button className="demo-link" onClick={onDemo} disabled={importing}><BookOpen size={15}/> 打开阅读示例 <ArrowUpRight size={13}/></button>}<div className="local-badge"><span className="online-dot"/><span>{vault ? '原 PDF 在 Obsidian，笔记与批注留在仓库' : '本地书桌 · 数据保存在此 Mac'}</span><LockKeyhole size={12}/></div></div>
    {dialog && <dialog ref={dialogRef} className="folder-dialog" aria-modal="true" aria-label={dialog.type === 'new' ? '新建文件夹' : dialog.type === 'rename' ? '重命名文件夹' : '删除文件夹'} onCancel={event => { event.preventDefault(); closeDialog(); }} onClose={closeDialog}><form onSubmit={submitFolder}><div className="modal-heading"><h2>{dialog.type === 'new' ? '新建文件夹' : dialog.type === 'rename' ? '重命名文件夹' : '删除文件夹'}</h2><button type="button" className="icon-button" aria-label="关闭文件夹窗口" disabled={busy} onClick={closeDialog}><X size={18}/></button></div>{dialog.type === 'delete' ? <p>删除“{dialog.folder.name}”？其中的文献会回到未分类，PDF、笔记和批注均保留。</p> : <label>文件夹名称<input autoFocus aria-label="文件夹名称" value={name} maxLength={80} onChange={event => setName(event.target.value)}/></label>}{error && <p role="alert" className="library-error">{error}</p>}<div className="button-row"><button type="button" className="text-button" onClick={closeDialog} disabled={busy}>取消</button><button className="primary-button" disabled={busy || (dialog.type !== 'delete' && !name.trim())}>{busy ? '正在保存…' : dialog.type === 'delete' ? '删除文件夹' : '保存文件夹'}</button></div></form></dialog>}
  </>;
}
