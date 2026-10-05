import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, Search, Upload, FileText, ArrowUpRight, Download, X, Highlighter, MessageSquare, Check, Trash2, Pencil, Library, LockKeyhole, LoaderCircle, ArrowRight, PanelRightClose, PanelRightOpen } from 'lucide-react';
import Reader from './Reader.jsx';
import Notes from './Notes.jsx';
import { api, patchDocument } from './api.js';

const sourceNames={text:'正文',title:'标题',notes:'笔记',annotation:'批注'};
const fmtSize=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;
function MarkedText({text,query}) {
  const index=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if(index<0||!query)return text;
  return <>{text.slice(0,index)}<mark>{text.slice(index,index+query.length)}</mark>{text.slice(index+query.length)}</>;
}
function AnnotationCard({annotation,onJump,onUpdate,onDelete}) {
  const [editing,setEditing]=useState(false),[comment,setComment]=useState(annotation.comment),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
  return <article className={`annotation-card border-${annotation.color}`}>
    <div className="annotation-top"><button className="page-link" onClick={()=>onJump(annotation)}>第 {annotation.page} 页 <ArrowUpRight size={12}/></button><div><button className="icon-button small" aria-label="编辑批注" onClick={()=>{setEditing(!editing);setComment(annotation.comment);}}><Pencil size={13}/></button><button className="icon-button small" aria-label="删除批注" onClick={()=>setConfirm(true)}><Trash2 size={13}/></button></div></div>
    <blockquote onClick={()=>onJump(annotation)}>{annotation.quote}</blockquote>
    {editing?<div className="annotation-edit"><textarea aria-label="编辑批注内容" value={comment} maxLength={20000} onChange={e=>setComment(e.target.value)}/><div className="button-row"><button className="text-button" onClick={()=>setEditing(false)}>取消</button><button disabled={busy} className="mini-primary" onClick={async()=>{setBusy(true);if(await onUpdate(annotation.id,{comment}))setEditing(false);setBusy(false);}}>保存</button></div></div>:<p className="annotation-comment">{annotation.comment||'仅高亮，暂无评论'}</p>}
    {confirm&&<div className="delete-confirm">删除这条批注？<button className="text-button" onClick={()=>setConfirm(false)}>取消</button><button className="text-button danger" disabled={busy} onClick={async()=>{setBusy(true);await onDelete(annotation.id);setBusy(false);setConfirm(false);}}>删除</button></div>}
  </article>;
}

export default function App() {
  const [documents,setDocuments]=useState([]),[current,setCurrent]=useState(null),[annotations,setAnnotations]=useState([]),[page,setPage]=useState(1);
  const [tab,setTab]=useState('notes'),[showNotes,setShowNotes]=useState(true),[query,setQuery]=useState(''),[results,setResults]=useState([]),[searching,setSearching]=useState(false),[find,setFind]=useState('');
  const [selection,setSelection]=useState(null),[modal,setModal]=useState(false),[comment,setComment]=useState(''),[color,setColor]=useState('yellow'),[annotationBusy,setAnnotationBusy]=useState(false),[focused,setFocused]=useState(null),[focusTick,setFocusTick]=useState(0);
  const [loading,setLoading]=useState(true),[opening,setOpening]=useState(false),[importing,setImporting]=useState(false),[toast,setToast]=useState(null),[dragging,setDragging]=useState(false),[exporting,setExporting]=useState(false);
  const currentIdRef=useRef(current?.id);currentIdRef.current=current?.id;
  const input=useRef(null),notesRef=useRef(null),openToken=useRef(0),toastTimer=useRef(null),searchSequence=useRef(0);
  const notify=useCallback((message,type='error')=>{setToast({message,type});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),type==='error'?11000:5000);},[]);
  const refresh=async()=>{const data=await api('/documents');setDocuments(data.documents);return data.documents;};
  const openDocument=async(id,targetPage)=>{
    const token=++openToken.current;setOpening(true);setSelection(null);setModal(false);setFind('');setFocused(null);
    try {await notesRef.current?.flush();if(token!==openToken.current)return false;const data=await api(`/documents/${id}`);if(token!==openToken.current)return false;setCurrent(data.document);setAnnotations(data.annotations);setPage(targetPage||data.document.lastPage||1);try{localStorage.setItem('paperdesk-current',id);}catch{}return true;}
    catch(err){if(token===openToken.current)notify(err.message);}
    finally{if(token===openToken.current)setOpening(false);}
  };
  useEffect(()=>{(async()=>{try{const docs=await refresh();let last;try{last=localStorage.getItem('paperdesk-current');}catch{}if(docs.length)await openDocument(docs.find(d=>d.id===last)?.id||docs[0].id);}catch(err){notify(`无法连接本地服务：${err.message}`);}finally{setLoading(false);}})();return()=>clearTimeout(toastTimer.current);},[]);
  useEffect(()=>{
    const seq=++searchSequence.current,controller=new AbortController();
    if(!query.trim()){setResults([]);setSearching(false);return;}
    setSearching(true);
    const timer=setTimeout(()=>api(`/search?q=${encodeURIComponent(query.trim())}`,{signal:controller.signal}).then(data=>{if(seq===searchSequence.current)setResults(data.results);}).catch(err=>{if(err.name!=='AbortError')notify(err.message);}).finally(()=>{if(seq===searchSequence.current)setSearching(false);}),230);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query]);
  useEffect(()=>{
    const handler=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();window.document.getElementById('library-search')?.focus();}};
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[]);
  const savedDoc=useCallback(doc=>{setDocuments(ds=>ds.map(d=>d.id===doc.id?doc:d));setCurrent(c=>c?.id===doc.id?{...c,...doc}:c);},[]);
  const changePage=n=>{setPage(n);setSelection(null);setFind('');setFocused(null);};
  useEffect(()=>{if(current)patchDocument(current.id,{lastPage:page}).catch(e=>notify(`阅读位置未保存：${e.message}`));},[current?.id,page]);
  const importFiles=async files=>{
    if(importing)return;
    if(modal||annotationBusy){notify('请先保存或关闭批注窗口，再导入 PDF。');return;}
    const list=[...files];if(!list.length)return;
    setImporting(true);let last,done=0,duplicates=0;const failures=[];
    for(const file of list){
      try{if(file.size>50*1024*1024)throw new Error('文件超过 50 MB');if(!/\.pdf$/i.test(file.name))throw new Error('请选择 PDF 文件');const body=new FormData();body.append('file',file);const data=await api('/documents',{method:'POST',body});last=data.document.id;data.duplicate?duplicates++:done++;}
      catch(err){failures.push(`${file.name}：${err.message}`);}
    }
    try{await refresh();if(last){setQuery('');await openDocument(last);}}catch(err){failures.push(err.message);}
    setImporting(false);if(input.current)input.current.value='';
    if(failures.length)notify(failures.join('；'));else notify(duplicates&&done===0?'这份 PDF 已在文献库中，已为你打开。':`已导入 ${done} 份文献${duplicates?`，跳过 ${duplicates} 份重复文件`:''}。`,'success');
  };
  const demo=async()=>{try{const r=await fetch('/examples/reading-demo.pdf');if(!r.ok)throw new Error('示例文件暂时无法读取');const blob=await r.blob();await importFiles([new File([blob],'reading-demo.pdf',{type:'application/pdf'})]);}catch(err){notify(err.message);}};
  const searchJump=async result=>{const opened=await openDocument(result.documentId,result.page||1);if(!opened)return;setFind(query.trim());if(result.source==='notes'){setTab('notes');setShowNotes(true);}if(result.source==='annotation'){setTab('annotations');setShowNotes(true);}};
  const createAnnotation=async()=>{
    if(!selection||!current||selection.documentId!==current.id)return;
    if(selection.rects.length>200){notify('选中的内容过长，请分段添加高亮。');return;}
    setAnnotationBusy(true);
    try{const {documentId,...body}=selection;const data=await api(`/documents/${documentId}/annotations`,{method:'POST',body:JSON.stringify({...body,comment,color})});if(currentIdRef.current!==documentId){notify('批注已保存到原文献。','success');return;}setAnnotations(as=>[...as,data.annotation]);setModal(false);setSelection(null);setComment('');setTab('annotations');setShowNotes(true);setFocused(data.annotation.id);window.getSelection()?.removeAllRanges();notify('高亮与批注已保存。','success');}
    catch(err){notify(err.message);}finally{setAnnotationBusy(false);}
  };
  const updateAnnotation=async(id,body)=>{try{const data=await api(`/documents/${current.id}/annotations/${id}`,{method:'PATCH',body:JSON.stringify(body)});setAnnotations(as=>as.map(a=>a.id===id?data.annotation:a));return true;}catch(err){notify(err.message);return false;}};
  const deleteAnnotation=async id=>{try{await api(`/documents/${current.id}/annotations/${id}`,{method:'DELETE'});setAnnotations(as=>as.filter(a=>a.id!==id));notify('批注已删除。','success');}catch(err){notify(err.message);}};
  const exportMarkdown=async()=>{
    if(!current)return;setExporting(true);
    try{await notesRef.current?.flush();const response=await fetch(`/api/documents/${current.id}/export`);if(!response.ok){const e=await response.json();throw new Error(e.error||'导出失败');}const blob=await response.blob();const url=URL.createObjectURL(blob),a=window.document.createElement('a');a.href=url;a.download=`${current.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'paper-notes'}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);notify('Markdown 已导出，包含双语笔记与全部批注。','success');}catch(err){notify(`导出未完成：${err.message}`);}finally{setExporting(false);}
  };
  return <div className="app-shell" onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragging(true);}}} onDrop={e=>{e.preventDefault();setDragging(false);importFiles(e.dataTransfer.files);}}>
    <input ref={input} className="hidden-input" type="file" accept=".pdf,application/pdf" multiple aria-label="选择 PDF 文件" onChange={e=>importFiles(e.target.files)}/>
    <aside className="sidebar" inert={modal||undefined}>
      <a href="#" className="brand" onClick={e=>{e.preventDefault();setQuery('');}}><span className="brand-mark"><BookOpen size={22}/></span><span>纸间<span className="brand-english">PAPERDESK</span></span></a>
      <div className="sidebar-caption">给阅读留一张安静的书桌。</div>
      <button className="import-button" disabled={importing} onClick={()=>input.current.click()}>{importing?<LoaderCircle size={17} className="spin"/>:<Plus size={18}/>} {importing?'正在导入与索引…':'导入 PDF'} <span>↗</span></button>
      <div className="search-field"><Search size={16}/><input id="library-search" aria-label="全文搜索" value={query} maxLength={200} onChange={e=>setQuery(e.target.value)} placeholder="搜索全文、笔记、批注"/>{query?<button className="clear-search" aria-label="清空搜索" onClick={()=>{setQuery('');setFind('');}}><X size={14}/></button>:<kbd>⌘ K</kbd>}</div>
      <div className="library-heading"><span>{query.trim()?'搜索结果':'我的文献'}</span><span>{query.trim()?(searching?'…':results.length):documents.length}</span></div>
      <nav className="document-list" aria-label="文献库">
        {loading?<p className="library-empty">正在打开书桌…</p>:query.trim()?<>{searching?<p className="library-empty">正在检索…</p>:results.length?results.map((r,i)=><button className={`search-result ${current?.id===r.documentId?'active':''}`} key={`${r.documentId}-${r.source}-${r.page}-${i}`} onClick={()=>searchJump(r)}><span className="result-source">{sourceNames[r.source]||'正文'} · 第 {r.page||1} 页</span><b>{r.title}</b><span className="result-snippet"><MarkedText text={r.snippet} query={query.trim()}/></span><ArrowUpRight className="result-arrow" size={14}/></button>):<p className="library-empty">没有找到“{query}”<small>试试更短的关键词。扫描件暂不支持全文搜索。</small></p>}{results.length>=100&&<p className="library-empty">仅显示前 100 条，请缩小搜索范围。</p>}</>:documents.length?documents.map((doc,i)=><button key={doc.id} className={`document-item ${current?.id===doc.id?'active':''}`} onClick={()=>openDocument(doc.id)}><span className="document-number">{String(i+1).padStart(2,'0')}</span><span className="document-details"><b>{doc.title}</b><small>{doc.pageCount} 页 <span>·</span> {fmtSize(doc.byteSize)}{!doc.textAvailable?' · 扫描件':''}</small></span><FileText size={15} className="doc-icon"/></button>):<p className="library-empty">书架还是空的。<small>导入你的第一篇论文，<br/>或者打开示例开始体验。</small></p>}
      </nav>
      <div className="sidebar-bottom"><button className="demo-link" onClick={demo} disabled={importing}><BookOpen size={15}/> 打开阅读示例 <ArrowUpRight size={13}/></button><div className="local-badge"><span className="online-dot"/><span>本地书桌 · 数据保存在此 Mac</span><LockKeyhole size={12}/></div></div>
    </aside>
    <main className="main-workspace" inert={modal||undefined}>
      <header className="workspace-header"><div className="header-title"><span className="eyebrow">YOUR READING SPACE</span><h1 title={current?.title}>{current?current.title:'把论文读成自己的理解。'}</h1></div><div className="header-actions">{current&&<><button className="secondary-button export-button" aria-label="导出 Markdown" title="导出 Markdown" disabled={exporting} onClick={exportMarkdown}>{exporting?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>}<span>导出 Markdown</span></button><button className="icon-button panel-toggle" aria-label={showNotes?'收起笔记面板':'展开笔记面板'} onClick={()=>setShowNotes(!showNotes)}>{showNotes?<PanelRightClose size={19}/>:<PanelRightOpen size={19}/>}</button></>}<span className="local-pill">LOCAL</span></div></header>
      {current?<div className={`reading-layout ${showNotes?'':'notes-hidden'}`}>
        <Reader document={current} page={page} onPage={changePage} annotations={annotations} onSelection={setSelection} selectionLocked={modal} find={find} focusedAnnotation={focused} focusTick={focusTick}/>
        <aside className={`notes-panel ${showNotes?'':'collapsed'}`} aria-label="笔记与批注" inert={opening||undefined}><div className="panel-tabs"><button className={tab==='notes'?'selected':''} onClick={()=>setTab('notes')}><Pencil size={14}/> 双语笔记</button><button className={tab==='annotations'?'selected':''} onClick={()=>setTab('annotations')}><MessageSquare size={14}/> 批注 <span>{annotations.length}</span></button></div>
          <div className={tab==='notes'?'panel-content':'panel-content invisible'}><Notes key={current.id} ref={notesRef} document={current} onSaved={savedDoc} onError={notify}/></div>
          {tab==='annotations'&&<div className="annotations-body"><div className="section-eyebrow">MARGINALIA</div><h2>与原文的对话</h2><p className="notes-intro">在 PDF 中选中文字，点击“高亮并批注”。点击页码可回到原文。</p>{annotations.length?annotations.slice().sort((a,b)=>a.page-b.page||a.createdAt.localeCompare(b.createdAt)).map(a=><AnnotationCard key={a.id} annotation={a} onJump={a=>{setPage(a.page);setFocused(a.id);setFocusTick(t=>t+1);setFind('');}} onUpdate={updateAnnotation} onDelete={deleteAnnotation}/>):<div className="empty-annotations"><Highlighter size={28} strokeWidth={1.25}/><p>第一条想法，从一句话开始。</p><span>选中原文 → 高亮 → 写下评论</span></div>}</div>}
        </aside>
        {opening&&<div className="opening-mask" role="status"><LoaderCircle className="spin"/> 正在打开文献…</div>}
      </div>:<section className="welcome"><div className="welcome-kicker"><span/> A QUIET PLACE FOR BIG IDEAS</div><h2>读过的每一页，<br/>都可以<span>有所留下。</span></h2><p>把文献、原文批注和双语思考放在一起。<br/>从一篇论文开始，慢慢建立自己的理解。</p><div className="welcome-actions"><button className="primary-button" disabled={importing} onClick={()=>input.current.click()}><Upload size={17}/> 导入第一篇 PDF <ArrowRight size={17}/></button><button className="text-button" disabled={importing} onClick={demo}>先用示例体验 <ArrowUpRight size={15}/></button></div><div className="desk-illustration" aria-hidden="true"><div className="book-back"/><div className="paper-card"><span>PAPER / 001</span><h3>The art of<br/>paying attention.</h3><div className="fake-line long"/><div className="fake-line"/><div className="fake-line highlighted"/><div className="fake-line short"/><div className="paper-stamp">read.<br/>think.<br/>keep.</div></div><div className="margin-note">有些句子，<br/>值得多停留一会儿。<span>↖</span></div></div><div className="welcome-features"><span><Search size={15}/> 全文检索</span><span><Highlighter size={15}/> 原文高亮</span><span><Pencil size={15}/> 双语笔记</span><span><LockKeyhole size={15}/> 完全本地</span></div></section>}
    </main>
    {selection&&!modal&&!opening&&<div className="selection-bar" onPointerDown={e=>e.preventDefault()}><Highlighter size={17}/><div className="selection-summary"><span>已选中 {selection.quote.length} 个字符 · 核对引文</span><p title={selection.quote}>{selection.quote}</p></div><button className="mini-primary" onClick={()=>{setComment('');setColor('yellow');setModal(true);}}>高亮并批注</button><button className="icon-button small" aria-label="取消选择" onClick={()=>{setSelection(null);window.getSelection()?.removeAllRanges();}}><X size={16}/></button></div>}
    {modal&&selection&&<div className="modal-backdrop" onKeyDown={e=>{if(e.key==='Escape'&&!annotationBusy)setModal(false);if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll('button:not(:disabled),textarea')];const first=items[0],last=items.at(-1);if(e.shiftKey&&window.document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&window.document.activeElement===last){e.preventDefault();first?.focus();}}}}><section className="annotation-modal" role="dialog" aria-modal="true" aria-labelledby="annotation-title"><div className="modal-heading"><div><span className="section-eyebrow">LEAVE A THOUGHT</span><h2 id="annotation-title">高亮与批注 <small>第 {selection.page} 页</small></h2></div><button className="icon-button" disabled={annotationBusy} aria-label="关闭批注窗口" onClick={()=>setModal(false)}><X size={20}/></button></div><blockquote>{selection.quote}</blockquote><label className="comment-label" htmlFor="new-comment">你的想法 <span>可选</span></label><textarea autoFocus id="new-comment" placeholder="为什么这句话值得留下？" maxLength={20000} value={comment} onChange={e=>setComment(e.target.value)}/><div className="modal-footer"><div className="color-picker" aria-label="高亮颜色">{[['yellow','黄色'],['green','绿色'],['pink','粉色']].map(([v,label])=><button key={v} aria-label={label} aria-pressed={color===v} className={`color-choice ${v}`} onClick={()=>setColor(v)}>{color===v&&<Check size={15}/>}</button>)}</div><button className="primary-button" disabled={annotationBusy} onClick={createAnnotation}>{annotationBusy?<LoaderCircle className="spin" size={16}/>:<Highlighter size={16}/>} 保存批注</button></div></section></div>}
    {toast&&<div className={`toast ${toast.type}`} role={toast.type==='error'?'alert':'status'}>{toast.type==='success'&&<Check size={16}/>}<span>{toast.message}</span><button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={16}/></button></div>}
    {dragging&&<div className="drop-overlay" onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();e.stopPropagation();setDragging(false);importFiles(e.dataTransfer.files);}}><Upload size={42}/><h2>把 PDF 放到书桌上</h2><p>支持多文件，每份最多 50 MB</p></div>}
  </div>;
}
