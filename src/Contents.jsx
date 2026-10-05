import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ListTree, LoaderCircle, Search, X } from 'lucide-react';
import { api } from './api.js';

function walk(entries, parents = []) {
  return entries.flatMap(entry => [{ ...entry, parents }, ...walk(entry.children, [...parents, entry.id])]);
}

function filterEntries(entries, query) {
  return entries.flatMap(entry => {
    if (entry.title.toLocaleLowerCase().includes(query)) return [entry];
    const children = filterEntries(entry.children, query);
    return children.length ? [{ ...entry, children }] : [];
  });
}

export default function Contents({ document, page, onJump, onClose }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(''), [expanded, setExpanded] = useState(new Set());
  const [manualOffset, setManualOffset] = useState(() => {
    try {
      const saved = localStorage.getItem(`paperdesk-toc-offset-${document.id}`);
      const value = saved === null ? null : Number(saved);
      return Number.isInteger(value) && Math.abs(value) <= document.pageCount ? value : null;
    } catch { return null; }
  });
  const [offsetInput, setOffsetInput] = useState(''), [offsetMessage, setOffsetMessage] = useState('');
  const activeRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError('');
    api(`/documents/${document.id}/toc`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [document.id, attempt]);
  useEffect(() => { setOffsetInput(String(manualOffset ?? data?.pageOffset ?? '')); }, [data, manualOffset]);

  const target = entry => {
    let result = entry.page;
    if (data?.source === 'contents' && manualOffset !== null && /^\d+$/.test(entry.printedPage || '')) {
      result = Number(entry.printedPage) + manualOffset;
    }
    return Number.isInteger(result) && result >= 1 && result <= document.pageCount ? result : null;
  };
  const all = useMemo(() => walk(data?.entries || []), [data]);
  const active = all.reduce((best, entry) => {
    const at = target(entry);
    return at !== null && at <= page && (best === null || at >= target(best)) ? entry : best;
  }, null);
  useEffect(() => {
    if (active) setExpanded(previous => new Set([...previous, ...active.parents]));
  }, [active?.id]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [active?.id, data, expanded]);
  const trimmed = query.trim().toLocaleLowerCase();
  const visible = trimmed ? filterEntries(data?.entries || [], trimmed) : data?.entries || [];
  const validOffset = /^-?\d+$/.test(offsetInput) && Math.abs(Number(offsetInput)) <= document.pageCount;
  const applyOffset = () => {
    if (!validOffset) return;
    const next = Number(offsetInput);
    setManualOffset(next);
    try { localStorage.setItem(`paperdesk-toc-offset-${document.id}`, String(next)); setOffsetMessage('已保存此文献的页码偏移。'); }
    catch { setOffsetMessage('偏移已应用，但浏览器未能保存；刷新后需重新设置。'); }
  };
  const resetOffset = () => {
    try { localStorage.removeItem(`paperdesk-toc-offset-${document.id}`); } catch {}
    setManualOffset(null); setOffsetMessage('已恢复自动识别的页码。');
  };
  const renderEntries = (entries, depth = 0) => <ul className="contents-list">{entries.map(entry => {
    const destination = target(entry), hasChildren = entry.children.length > 0;
    const open = trimmed || expanded.has(entry.id), selected = active?.id === entry.id;
    return <li key={entry.id}>
      <div className={`contents-row ${selected ? 'current' : ''}`} style={{ '--depth': depth }}>
        {hasChildren ? <button className="contents-disclosure" aria-label={`${open ? '收起' : '展开'}章节：${entry.title}`} aria-expanded={Boolean(open)} disabled={Boolean(trimmed)} onClick={() => setExpanded(previous => {
          const next = new Set(previous); next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id); return next;
        })}>{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button> : <span className="contents-disclosure-spacer"/>}
        <button ref={selected ? activeRef : null} className="contents-jump" aria-current={selected ? 'location' : undefined} disabled={destination === null} aria-label={destination === null ? `${entry.title}，页码未确认` : `${entry.title}，PDF 第 ${destination} 页`} title={destination === null ? `${entry.title}：没有可确认的本机页码` : `${entry.title} · PDF 第 ${destination} 页${entry.printedPage ? ` · 书中 ${entry.printedPage} 页` : ''}`} onClick={() => onJump(destination)}>
          <span>{entry.title}</span><small>{destination ?? '—'}</small>
        </button>
      </div>
      {hasChildren && open && renderEntries(entry.children, depth + 1)}
    </li>;
  })}</ul>;

  return <aside className="contents-panel" aria-label="目录面板" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className="contents-heading"><div><span className="section-eyebrow">CONTENTS</span><h2><ListTree size={17}/> 章节目录</h2></div><button className="icon-button" aria-label="关闭目录" onClick={onClose}><X size={17}/></button></div>
    {error ? <div className="contents-message" role="alert"><p>目录读取失败：{error}</p><button className="text-button" onClick={() => setAttempt(value => value + 1)}>重试目录识别</button></div>
      : !data ? <div className="contents-message" role="status"><LoaderCircle className="spin" size={17}/><p>正在识别目录…</p></div>
      : !all.length ? <div className="contents-message"><ListTree size={26} strokeWidth={1.25}/><p>未找到可跳转的目录</p><small>优先读取 PDF 内置书签，再识别前 {data.scannedPages} 页的文字目录。扫描目录暂不支持识别。</small></div>
      : <>
        <div className="contents-meta"><span>{data.source === 'bookmarks' ? 'PDF 内置书签' : '目录页识别'} · {all.length} 条</span><small>右侧数字为 PDF 页码</small></div>
        <label className="contents-search"><Search size={13}/><input aria-label="筛选章节" placeholder="查找章节" value={query} onChange={event => setQuery(event.target.value)} maxLength={200}/>{query && <button aria-label="清空章节筛选" onClick={() => setQuery('')}><X size={13}/></button>}</label>
        {data.source === 'contents' && <details className="contents-offset" open={manualOffset === null && !data.offsetVerified ? true : undefined}>
          <summary>页码校正{manualOffset !== null ? ` · 手动 ${manualOffset >= 0 ? '+' : ''}${manualOffset}` : data.offsetVerified ? ' · 已自动确认' : ' · 需要确认'}</summary>
          <p>PDF 页码 = 书中页码 + 偏移。例如书中第 1 页在 PDF 第 21 页，填 20。</p>
          <div><input aria-label="目录页码偏移" type="number" min={-document.pageCount} max={document.pageCount} step="1" value={offsetInput} onChange={event => setOffsetInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyOffset(); }}/><button className="mini-primary" disabled={!validOffset} onClick={applyOffset}>应用偏移</button></div>
          {manualOffset !== null && <button className="text-button" onClick={resetOffset}>恢复自动</button>}
          {offsetMessage && <p role="status">{offsetMessage}</p>}
        </details>}
        <nav className="contents-navigation" aria-label="章节目录">{visible.length ? renderEntries(visible) : <p className="contents-no-match">没有匹配的章节。</p>}</nav>
        {data.truncated && <p className="contents-limit">目录较长，已显示可处理的条目；文字目录仅检查前 40 页。</p>}
      </>}
  </aside>;
}
