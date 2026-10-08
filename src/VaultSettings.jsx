import React, { useEffect, useRef } from 'react';
import { ExternalLink, FolderOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import './vault.css';

export default function VaultSettings({ open, onClose, storage, documentTitle, onRefresh, onOpenNote, busy, error }) {
  const dialog = useRef(null), opener = useRef(null);
  useEffect(() => {
    if (!open) return;
    opener.current = window.document.activeElement;
    dialog.current?.showModal();
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  const vault = storage?.mode === 'vault';
  return <dialog ref={dialog} className="vault-dialog" aria-label="资料位置" aria-modal="true"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled),a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="vault-heading"><h2><FolderOpen size={19}/> 资料位置</h2><button autoFocus className="icon-button" aria-label="关闭资料位置" disabled={busy} onClick={onClose}><X size={19}/></button></div>
    {storage ? <>
      <div className="vault-location"><span>{vault ? 'Obsidian 仓库' : '本机文献库'}</span><strong>{vault ? storage.vaultName : 'Paperdesk 文献库'}</strong>{vault && <span>资料文件夹：{storage.subdir}</span>}<span>{storage.documentCount} 份文献</span></div>
      <p className="vault-description">{vault ? 'PDF、笔记与批注保存在这个仓库中。你在 Obsidian 中编辑笔记后，Paperdesk 会自动读回；有冲突时保留草稿。' : 'PDF、笔记与批注保存在本机文献库。'}</p>
      {vault ? <div className="vault-actions"><button className="secondary-button" disabled={busy} onClick={onRefresh}>{busy ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} 重新读取仓库</button><button className="primary-button" disabled={busy || !documentTitle} onClick={onOpenNote}><ExternalLink size={15}/> 在 Obsidian 中打开笔记</button></div>
        : <p className="vault-description">{window.paperdeskDesktop ? '使用「文件 → 打开 Obsidian 仓库…」选择已有仓库。' : '浏览器版可通过启动时指定 Obsidian 仓库目录接入。'}</p>}
      {vault && documentTitle && <p className="vault-current">当前文献：{documentTitle}</p>}
    </> : <p className="vault-description">正在读取资料位置…</p>}
    {error && <p className="vault-error" role="alert">{error}</p>}
  </dialog>;
}
