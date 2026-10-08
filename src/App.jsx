import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, Search, Upload, FileText, ArrowUpRight, Download, X, Highlighter, MessageSquare, Check, Trash2, Pencil, Library, LockKeyhole, LoaderCircle, ArrowRight, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen, ScanLine, Languages } from 'lucide-react';
import Reader from './Reader.jsx';
import Notes from './Notes.jsx';
import AnnotationCard from './AnnotationCard.jsx';
import { canRetryAnnotationAttempt, createAnnotationDraftStore } from './annotation-drafts.mjs';
import { createReadingPositionQueue, installReadingPositionLifecycle } from './reading-position.js';
import Translation from './Translation.jsx';
import LibraryPanel from './Library.jsx';
import { DOCUMENT_DRAG_TYPE } from '../shared/library.mjs';
import { api } from './api.js';
import { readDeepLink, useCodexContext } from './codex-context.js';
import './codex.css';

const sourceNames={text:'正文',title:'标题',notes:'笔记',annotation:'批注'};
function MarkedText({text,query}) {
  const index=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if(index<0||!query)return text;
  return <>{text.slice(0,index)}<mark>{text.slice(index,index+query.length)}</mark>{text.slice(index+query.length)}</>;
}
export default function App() {
  const [documents,setDocuments]=useState([]),[current,setCurrent]=useState(null),[annotations,setAnnotations]=useState([]),[page,setPage]=useState(1);
  const [tab,setTab]=useState('notes'),[showNotes,setShowNotes]=useState(true),[query,setQuery]=useState(''),[results,setResults]=useState([]),[searching,setSearching]=useState(false),[find,setFind]=useState('');
  const [tocOpen,setTocOpen]=useState(false);
  const [translationSettingsOpen,setTranslationSettingsOpen]=useState(false);
  const translationRef=useRef(null);
  const [notesState,setNotesState]=useState({documentId:null,dirty:false});
  const [showLibrary,setShowLibrary]=useState(()=>{try{return localStorage.getItem('paperdesk-library-collapsed')!=='true';}catch{return true;}});
  const librarySearchPending=useRef(false);
  const [selection,setSelection]=useState(null),[modal,setModal]=useState(false),[comment,setComment]=useState(''),[color,setColor]=useState('yellow'),[annotationBusy,setAnnotationBusy]=useState(false),[focused,setFocused]=useState(null),[focusTick,setFocusTick]=useState(0);
  const [loading,setLoading]=useState(true),[opening,setOpening]=useState(false),[importing,setImporting]=useState(false),[toast,setToast]=useState(null),[dragging,setDragging]=useState(false),[exporting,setExporting]=useState(false);
  const [desktopSwitching,setDesktopSwitching]=useState(false);
  const [libraryId,setLibraryId]=useState(null),[,setDraftTick]=useState(0);
  const draftStoreRef=useRef(null);
  if(!draftStoreRef.current)draftStoreRef.current=createAnnotationDraftStore({onChange:()=>setDraftTick(tick=>tick+1)});
  const drafts=draftStoreRef.current,libraryIdentityPromise=useRef(null),newDraftRef=useRef(null),annotationRequests=useRef(new Set()),readingPositionRef=useRef(null);
  const trackAnnotation=work=>{annotationRequests.current.add(work);work.then(()=>annotationRequests.current.delete(work),()=>annotationRequests.current.delete(work));return work;};
  const ensureLibraryIdentity=()=>{
    if(!libraryIdentityPromise.current)libraryIdentityPromise.current=api('/plugin/status').then(status=>{
      drafts.setLibrary(status.libraryId);
      readingPositionRef.current=createReadingPositionQueue({scope:status.libraryId,
        save:(id,lastPage,{positionWriterId,positionSequence,keepalive})=>api(`/documents/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({lastPage,positionWriterId,positionSequence}),keepalive}),
        onError:error=>notify(`阅读位置未保存：${error.message}`),
        onStorageError:()=>notify('浏览器无法暂存阅读位置。请保持页面打开，等待位置保存成功后再关闭。'),
      });
      setLibraryId(status.libraryId);return status.libraryId;
    }).catch(error=>{libraryIdentityPromise.current=null;throw error;});
    return libraryIdentityPromise.current;
  };
  const flushAnnotations=async()=>{await Promise.all([...annotationRequests.current]);if(drafts.hasDrafts())throw new Error('仍有未保存的批注评论，草稿已保留。请保存或明确放弃草稿后重试。');};
  const flushAnnotationsRef=useRef(flushAnnotations);flushAnnotationsRef.current=flushAnnotations;
  useEffect(()=>window.paperdeskDesktop?.onLibrarySwitch(setDesktopSwitching),[]);
  const desktopBusy=useRef(false);desktopBusy.current=importing||opening||exporting;
  useEffect(()=>window.paperdeskDesktop?.onFlushRequest(async()=>{
    if(desktopBusy.current)throw new Error('导入、打开或导出尚未完成，请稍候再关闭。');
    await notesRef.current?.flush();
    if(notesRef.current?.isDirty())throw new Error('仍有未保存的笔记，请确认保存后重试。');
    await flushAnnotationsRef.current();
    await readingPositionRef.current?.flush();
  }),[]);
  useEffect(()=>libraryId&&readingPositionRef.current?installReadingPositionLifecycle(readingPositionRef.current):undefined,[libraryId]);
  useEffect(()=>{
    const warn=event=>{if(drafts.hasDrafts()||annotationRequests.current.size){event.preventDefault();event.returnValue='';}};
    const update=()=>setDraftTick(tick=>tick+1);
    window.addEventListener('beforeunload',warn);window.addEventListener('storage',update);
    return()=>{window.removeEventListener('beforeunload',warn);window.removeEventListener('storage',update);};
  },[]);
  const currentIdRef=useRef(current?.id);currentIdRef.current=current?.id;
  const input=useRef(null),notesRef=useRef(null),openToken=useRef(0),toastTimer=useRef(null),searchSequence=useRef(0);
  const notify=useCallback((message,type='error')=>{setToast({message,type});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),type==='error'?11000:5000);},[]);
  const refreshSequence=useRef(0);
  const refresh=async()=>{const sequence=++refreshSequence.current;const data=await api('/documents');if(sequence===refreshSequence.current){setDocuments(data.documents);setCurrent(value=>{const doc=data.documents.find(item=>item.id===value?.id);return doc?{...value,folderId:doc.folderId}:value;});}return data.documents;};
  const folderChanged=(id,folderId)=>{++refreshSequence.current;const apply=doc=>doc?.id===id?{...doc,folderId}:doc;setDocuments(items=>items.map(apply));setCurrent(apply);};
  const commitPage=(number,id=currentIdRef.current)=>{if(id)readingPositionRef.current?.enqueue(id,number);setPage(number);};
  const openDocument=async(id,targetPage)=>{
    const token=++openToken.current;setOpening(true);setSelection(null);setModal(false);setFind('');setFocused(null);
    try {await ensureLibraryIdentity();await notesRef.current?.flush();if(currentIdRef.current)await readingPositionRef.current.flush(currentIdRef.current);if(token!==openToken.current)return false;const data=await api(`/documents/${encodeURIComponent(id)}`);if(token!==openToken.current)return false;const restored=readingPositionRef.current.restore(data.document);const requested=targetPage??restored;const valid=Number.isSafeInteger(requested)&&requested>=1&&requested<=data.document.pageCount;setCurrent(data.document);setAnnotations(data.annotations);commitPage(valid?requested:1,data.document.id);if(!valid)notify('链接中的页码无效，已打开第 1 页。');try{localStorage.setItem('paperdesk-current',id);}catch{}return true;}
    catch(err){if(token===openToken.current)notify(err.message);}
    finally{if(token===openToken.current)setOpening(false);}
  };
  useEffect(()=>{(async()=>{try{const docs=await refresh();const link=readDeepLink();let last;try{last=localStorage.getItem('paperdesk-current');}catch{}const linked=docs.find(d=>d.id===link.documentId);if(docs.length)await openDocument(linked?.id||docs.find(d=>d.id===last)?.id||docs[0].id,linked?(link.invalid?1:link.page):undefined);if(link.invalid)notify('链接中的页码格式无效，请使用正整数页码。');else if(link.documentId&&!linked)notify('链接中的文献不在当前文献库中。');}catch(err){notify(`无法连接本地服务：${err.message}`);}finally{setLoading(false);}})();return()=>clearTimeout(toastTimer.current);},[]);
  useEffect(()=>{
    const seq=++searchSequence.current,controller=new AbortController();
    if(!query.trim()){setResults([]);setSearching(false);return;}
    setSearching(true);
    const timer=setTimeout(()=>api(`/search?q=${encodeURIComponent(query.trim())}`,{signal:controller.signal}).then(data=>{if(seq===searchSequence.current)setResults(data.results);}).catch(err=>{if(err.name!=='AbortError')notify(err.message);}).finally(()=>{if(seq===searchSequence.current)setSearching(false);}),230);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query]);
  useEffect(()=>{
    const handler=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'&&!window.document.querySelector('[aria-modal="true"]')){e.preventDefault();if(window.document.getElementById('library-panel')?.classList.contains('collapsed')){librarySearchPending.current=true;setShowLibrary(true);}else window.document.getElementById('library-search')?.focus();}};
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[]);
  useEffect(()=>{try{localStorage.setItem('paperdesk-library-collapsed',String(!showLibrary));}catch{}if(showLibrary&&librarySearchPending.current){librarySearchPending.current=false;window.document.getElementById('library-search')?.focus();}},[showLibrary]);
  const toggleLibrary=()=>{setSelection(value=>value?.kind==='region'?value:null);setShowLibrary(value=>!value);};
  // Heartbeats and completed saves carry the revision they started from. A
  // delayed response must not roll a newer save (or a different book) backward.
  const savedDoc=useCallback((doc,expectedRevision)=>{if(!doc)return;const apply=d=>d?.id===doc.id&&(expectedRevision===undefined||d.notesRevision===expectedRevision||d.notesRevision===doc.notesRevision)?{...d,...doc,folderId:d.folderId}:d;setDocuments(ds=>ds.map(apply));setCurrent(apply);},[]);
  const notesDirtyChanged=useCallback((documentId,dirty)=>{if(currentIdRef.current===documentId)setNotesState(value=>value.documentId===documentId&&value.dirty===dirty?value:{documentId,dirty});},[]);
  const codex=useCodexContext({document:current,page,selection,notesDirty:notesState.documentId===current?.id&&notesState.dirty,onDocument:savedDoc,onError:notify});
  const changePage=(n,{source}={})=>{if(modal||translationSettingsOpen||!Number.isSafeInteger(n)||n<1||n>(current?.pageCount||0))return;commitPage(n);if(source!=='selection')setSelection(null);setFind('');setFocused(null);};
  const toggleToc=open=>{setTocOpen(open);setSelection(null);if(open&&window.matchMedia('(max-width:780px)').matches)setShowNotes(false);};
  const toggleNotes=()=>{if(!showNotes&&window.matchMedia('(max-width:780px)').matches)setTocOpen(false);setShowNotes(!showNotes);};
  const revealNotes=()=>{if(window.matchMedia('(max-width:780px)').matches)setTocOpen(false);setShowNotes(true);};
  useEffect(()=>{
    const media=window.matchMedia('(max-width:780px)');
    const fitPanels=()=>{if(media.matches&&tocOpen)setShowNotes(false);};
    fitPanels();media.addEventListener('change',fitPanels);
    return()=>media.removeEventListener('change',fitPanels);
  },[tocOpen]);
  useEffect(()=>{if(current&&libraryId)readingPositionRef.current.enqueue(current.id,page);},[current?.id,page,libraryId]);
  const importFiles=async files=>{
    if(importing)return;
    if(translationSettingsOpen){notify('请先关闭翻译设置，再导入 PDF。');return;}
    if(modal||annotationBusy){notify('请先保存或关闭批注窗口，再导入 PDF。');return;}
    const list=[...files];if(!list.length)return;
    setImporting(true);let last,done=0,duplicates=0;const failures=[];
    for(const file of list){
      try{if(!/\.pdf$/i.test(file.name))throw new Error('请选择 PDF 文件');const body=new FormData();body.append('file',file);const data=await api('/documents',{method:'POST',body});last=data.document.id;data.duplicate?duplicates++:done++;}
      catch(err){failures.push(`${file.name}：${err.message}`);}
    }
    try{await refresh();if(last){setQuery('');await openDocument(last);}}catch(err){failures.push(err.message);}
    setImporting(false);if(input.current)input.current.value='';
    if(failures.length)notify(failures.join('；'));else notify(duplicates&&done===0?'这份 PDF 已在文献库中，已为你打开。':`已导入 ${done} 份文献${duplicates?`，跳过 ${duplicates} 份重复文件`:''}。`,'success');
  };
  const demo=async()=>{try{const r=await fetch('/examples/reading-demo.pdf');if(!r.ok)throw new Error('示例文件暂时无法读取');const blob=await r.blob();await importFiles([new File([blob],'reading-demo.pdf',{type:'application/pdf'})]);}catch(err){notify(err.message);}};
  const searchJump=async result=>{const opened=await openDocument(result.documentId,result.page||1);if(!opened)return;setFind(query.trim());if(result.source==='notes'){setTab('notes');revealNotes();}if(result.source==='annotation'){setTab('annotations');revealNotes();}};
  const beginAnnotation=value=>{
    try{const draft=drafts.newDraft(value);newDraftRef.current=draft;setComment(draft.comment);setColor(draft.color);setModal(true);}catch(error){notify(error.message);}
  };
  const changeComment=value=>{const draft=newDraftRef.current;if(!draft||draft.attempt)return;newDraftRef.current=drafts.write({...draft,comment:value});setComment(value);};
  const changeColor=value=>{const draft=newDraftRef.current;if(!draft||draft.attempt)return;newDraftRef.current=drafts.write({...draft,color:value});setColor(value);};
  const discardNewDraft=()=>{const draft=newDraftRef.current;if(draft?.generation)drafts.clear(draft);newDraftRef.current=null;setModal(false);setSelection(null);setComment('');};
  const restoreNewDraft=draft=>{
    if(!current||draft.documentId!==current.id||draft.selection.page>current.pageCount){notify('草稿的文献或页码不再有效，请在历史草稿中核对评论。');return;}
    commitPage(draft.selection.page);setSelection({...draft.selection,restored:true});newDraftRef.current=draft;setComment(draft.comment);setColor(draft.color);setModal(true);
  };
  const createAnnotation=async()=>{
    if(annotationBusy||!selection||!current||selection.documentId!==current.id)return;
    if(selection.rects.length>200){notify('选中的内容过长，请分段添加高亮。');return;}
    const draft=newDraftRef.current||drafts.newDraft(selection);
    if(draft.attempt&&!canRetryAnnotationAttempt(draft.attempt)){notify('这份草稿已超出安全重试时限。请先核对文献中的已保存批注；草稿仍保留，确认未保存后再放弃草稿并重新批注。');return;}
    const snapshot=draft.attempt?draft:drafts.write({...draft,comment,color,attempt:{firstAttemptAt:new Date().toISOString(),body:{...draft.selection,documentId:undefined,comment,color,requestId:draft.requestId}}});
    newDraftRef.current=snapshot;
    const {documentId}=snapshot;
    setAnnotationBusy(true);
    try{const data=await trackAnnotation(api(`/documents/${documentId}/annotations`,{method:'POST',body:JSON.stringify(snapshot.attempt.body)}));drafts.clear(snapshot);if(currentIdRef.current!==documentId){notify('批注已保存到原文献。','success');return;}setAnnotations(as=>[...as.filter(a=>a.id!==data.annotation.id),data.annotation]);setModal(false);setSelection(null);setComment('');newDraftRef.current=null;setTab('annotations');revealNotes();setFocused(data.annotation.id);window.getSelection()?.removeAllRanges();notify(snapshot.selection.kind==='region'?'区域批注已保存。':'高亮与批注已保存。','success');}
    catch(err){
      // A definite validation rejection cannot have committed. Network/server
      // failures retain the immutable attempt for an idempotent confirmation.
      if([400,404,413].includes(err.status)){const retained=drafts.write({...snapshot,attempt:undefined});newDraftRef.current=retained;}
      notify(`批注未确认保存，草稿已保留：${err.message}`);
    }finally{setAnnotationBusy(false);}
  };
  const updateAnnotation=async(documentId,id,body)=>{try{const data=await trackAnnotation(api(`/documents/${documentId}/annotations/${id}`,{method:'PATCH',body:JSON.stringify(body)}));if(currentIdRef.current===documentId)setAnnotations(as=>as.map(a=>a.id===id?data.annotation:a));return data.annotation;}catch(err){notify(err.message);throw err;}};
  const deleteAnnotation=async(documentId,id)=>{try{await trackAnnotation(api(`/documents/${documentId}/annotations/${id}`,{method:'DELETE'}));if(currentIdRef.current===documentId)setAnnotations(as=>as.filter(a=>a.id!==id));notify('批注已删除。','success');}catch(err){notify(err.message);throw err;}};
  const reloadAnnotation=async(documentId,id)=>{const data=await api(`/documents/${documentId}`);const annotation=data.annotations.find(a=>a.id===id);if(!annotation)throw new Error('这条批注已被删除，草稿仍保留。');if(currentIdRef.current===documentId)setAnnotations(as=>as.map(a=>a.id===id?annotation:a));return annotation;};
  const currentDrafts=current?drafts.list(current.id):[],historicalDrafts=current?drafts.history(current.id):[];
  const exportMarkdown=async()=>{
    if(!current)return;setExporting(true);
    try{await notesRef.current?.flush();const response=await fetch(`/api/documents/${current.id}/export`);if(!response.ok){const e=await response.json();throw new Error(e.error||'导出失败');}const blob=await response.blob();const url=URL.createObjectURL(blob),a=window.document.createElement('a');a.href=url;a.download=`${current.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'paper-notes'}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);notify('Markdown 已导出，包含笔记与全部批注。','success');}catch(err){notify(`导出未完成：${err.message}`);}finally{setExporting(false);}
  };
  return <div className="app-shell" inert={desktopSwitching||undefined} aria-busy={desktopSwitching} onDragOver={e=>{if(e.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)){e.preventDefault();return;}if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragging(true);}}} onDrop={e=>{e.preventDefault();setDragging(false);if(!e.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)&&e.dataTransfer.files.length)importFiles(e.dataTransfer.files);}}>
    <input ref={input} className="hidden-input" type="file" accept=".pdf,application/pdf" multiple aria-label="选择 PDF 文件" onChange={e=>importFiles(e.target.files)}/>
    <aside id="library-panel" className={`sidebar library-sidebar ${showLibrary?'':'collapsed'}`} aria-label="文献栏" inert={modal||!showLibrary||undefined}>
      <LibraryPanel documents={documents} currentId={current?.id} loading={loading} importing={importing} query={query} onQuery={setQuery} onClearSearch={()=>{setQuery('');setFind('');}} onImport={()=>input.current.click()} onDemo={demo} onOpen={openDocument} onRefresh={refresh} onFolderChange={folderChanged} searchCount={searching?'…':results.length} searchResults={<>{searching?<p className="library-empty">正在检索…</p>:results.length?results.map((r,i)=><button className={`search-result ${current?.id===r.documentId?'active':''}`} key={`${r.documentId}-${r.source}-${r.page}-${i}`} onClick={()=>searchJump(r)}><span className="result-source">{sourceNames[r.source]||'正文'} · 第 {r.page||1} 页</span><b>{r.title}</b><span className="result-snippet"><MarkedText text={r.snippet} query={query.trim()}/></span><ArrowUpRight className="result-arrow" size={14}/></button>):<p className="library-empty">没有找到“{query}”<small>试试更短的关键词。扫描件暂不支持全文搜索。</small></p>}{results.length>=100&&<p className="library-empty">仅显示前 100 条，请缩小搜索范围。</p>}</>}/>
    </aside>
    <main className="main-workspace" inert={modal||undefined}>
      <header className="workspace-header"><button className="icon-button library-toggle" aria-label={showLibrary?'收起文献栏':'展开文献栏'} title={showLibrary?'收起文献栏':'展开文献栏'} aria-expanded={showLibrary} aria-controls="library-panel" onClick={toggleLibrary}>{showLibrary?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}</button><div className="header-title"><span className="eyebrow">YOUR READING SPACE</span><h1 title={current?.title}>{current?current.title:'把论文读成自己的理解。'}</h1></div><div className="header-actions"><button className="secondary-button translation-settings-button" onClick={()=>translationRef.current?.openSettings()}><Languages size={15}/> 翻译设置</button>{current&&!codex.dismissed&&<div className="codex-status" data-shared={codex.shared} role="status"><span>{codex.status==='shared'?'选区已共享':codex.status==='error'?'阅读上下文暂不可用':codex.status==='ready'?'阅读上下文已就绪':'正在准备阅读上下文…'}</span><button className="icon-button small" aria-label={codex.shared?'停止共享选区':'关闭 Codex 状态'} onClick={codex.shared?codex.clear:codex.dismiss}><X size={13}/></button></div>}{current&&<><button className="secondary-button export-button" aria-label="导出 Markdown" title="导出 Markdown" disabled={exporting} onClick={exportMarkdown}>{exporting?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>}<span>导出 Markdown</span></button><button className="icon-button panel-toggle" aria-label={showNotes?'收起笔记面板':'展开笔记面板'} onClick={toggleNotes}>{showNotes?<PanelRightClose size={19}/>:<PanelRightOpen size={19}/>}</button></>}<span className="local-pill">LOCAL</span></div></header>
      {current?<div className={`reading-layout ${showNotes?'':'notes-hidden'}`}>
        <Reader document={current} page={page} onPage={changePage} annotations={annotations} selection={selection} onSelection={setSelection} selectionLocked={modal||translationSettingsOpen} find={find} focusedAnnotation={focused} focusTick={focusTick} tocOpen={tocOpen} onToggleToc={toggleToc}/>
        <aside className={`notes-panel ${showNotes?'':'collapsed'}`} aria-label="笔记与批注" inert={opening||undefined}><div className="panel-tabs"><button className={tab==='notes'?'selected':''} onClick={()=>setTab('notes')}><Pencil size={14}/> 笔记</button><button className={tab==='annotations'?'selected':''} onClick={()=>setTab('annotations')}><MessageSquare size={14}/> 批注 <span>{annotations.length}</span></button></div>
          <div className={tab==='notes'?'panel-content':'panel-content invisible'}><Notes key={current.id} ref={notesRef} document={current} onSaved={savedDoc} onError={notify} onDirtyChange={notesDirtyChanged}/></div>
          {tab==='annotations'&&<div className="annotations-body"><div className="section-eyebrow">MARGINALIA</div><h2>与原文的对话</h2><p className="notes-intro">选中文字可高亮；扫描页、公式和图表可用“区域批注”框选。点击批注可回到标记处。</p>{currentDrafts.filter(draft=>!draft.annotationId).map(draft=><div className="draft-hint" key={draft.target}><p>第 {draft.selection.page} 页有未保存的{draft.selection.kind==='region'?'区域':'文字'}批注草稿。</p><button className="text-button" onClick={()=>restoreNewDraft(draft)}>恢复第 {draft.selection.page} 页批注草稿</button><button className="text-button" onClick={()=>drafts.clear(draft)}>放弃草稿</button></div>)}{currentDrafts.filter(draft=>draft.annotationId&&!annotations.some(annotation=>annotation.id===draft.annotationId)).map(draft=><div className="draft-hint" key={draft.target}><p>对应批注已不在文献中，这份评论草稿仍可复制。</p><textarea readOnly aria-label="已删除批注的评论草稿" value={draft.comment}/><button className="text-button" onClick={()=>drafts.clear(draft)}>放弃草稿</button></div>)}{annotations.length?annotations.slice().sort((a,b)=>a.page-b.page||a.createdAt.localeCompare(b.createdAt)).map(a=><AnnotationCard key={a.id} annotation={a} drafts={drafts} onJump={a=>{setSelection(null);commitPage(a.page);setFocused(a.id);setFocusTick(t=>t+1);setFind('');if(window.matchMedia('(max-width:780px)').matches){setShowNotes(false);setTocOpen(false);}}} onUpdate={updateAnnotation} onDelete={deleteAnnotation} onReload={reloadAnnotation}/>):<div className="empty-annotations"><Highlighter size={28} strokeWidth={1.25}/><p>给值得回看的地方，留下想法。</p><span>选中文字或框选区域 → 写下评论</span></div>}{historicalDrafts.length>0&&<details className="historical-drafts"><summary>其他窗口与历史批注草稿（{historicalDrafts.length}）</summary><p>请核对文献与页码后复制评论；这些草稿不会自动载入或覆盖当前窗口。</p>{historicalDrafts.map((draft,index)=><label key={draft.storedKey}>{draft.annotationId?'已有批注评论':`第 ${draft.selection.page} 页${draft.selection.kind==='region'?'区域':'文字'}批注`}<textarea readOnly aria-label={`其他窗口或历史批注草稿 ${index+1}`} value={draft.comment}/></label>)}</details>}</div>}
          {drafts.storageError&&<p className="inline-error" role="alert">浏览器批注草稿无法写入，请保留当前窗口并确认保存成功后再关闭。</p>}
        </aside>
        {opening&&<div className="opening-mask" role="status"><LoaderCircle className="spin"/> 正在打开文献…</div>}
      </div>:<section className="welcome"><div className="welcome-kicker"><span/> A QUIET PLACE FOR BIG IDEAS</div><h2>读过的每一页，<br/>都可以<span>有所留下。</span></h2><p>把文献、原文批注和阅读笔记放在一起。<br/>从一篇论文开始，慢慢建立自己的理解。</p><div className="welcome-actions"><button className="primary-button" disabled={importing} onClick={()=>input.current.click()}><Upload size={17}/> 导入第一篇 PDF <ArrowRight size={17}/></button><button className="text-button" disabled={importing} onClick={demo}>先用示例体验 <ArrowUpRight size={15}/></button></div><div className="desk-illustration" aria-hidden="true"><div className="book-back"/><div className="paper-card"><span>PAPER / 001</span><h3>The art of<br/>paying attention.</h3><div className="fake-line long"/><div className="fake-line"/><div className="fake-line highlighted"/><div className="fake-line short"/><div className="paper-stamp">read.<br/>think.<br/>keep.</div></div><div className="margin-note">有些句子，<br/>值得多停留一会儿。<span>↖</span></div></div><div className="welcome-features"><span><Search size={15}/> 全文检索</span><span><Highlighter size={15}/> 原文高亮</span><span><Pencil size={15}/> 笔记</span><span><LockKeyhole size={15}/> 完全本地</span></div></section>}
    </main>
    {selection&&!modal&&!opening&&<div className="selection-bar" aria-label="选区操作" onPointerDown={e=>e.preventDefault()}>{selection.kind==='region'?<ScanLine size={17}/>:<Highlighter size={17}/>}<div className="selection-summary">{selection.kind==='region'?<><span>区域批注 · 第 {selection.page} 页</span><p>已框选页面区域，添加一条想法。</p></>:<><span>已选中 {selection.quote.length} 个字符 · 核对引文</span><p title={selection.quote}>{selection.quote}</p></>}</div><>{selection.kind==='region'?<span className="translation-region-hint">图片选区需先识别文字</span>:<button className="text-button translation-action" onClick={()=>translationRef.current?.translate(selection)}>翻译</button>}</><button className="text-button codex-share" onClick={codex.share}>交给 Codex</button><button className="mini-primary" onClick={()=>beginAnnotation(selection)}>{selection.kind==='region'?'添加区域批注':'高亮并批注'}</button><button className="icon-button small" aria-label="取消选择" onClick={()=>{translationRef.current?.closeResult();setSelection(null);window.getSelection()?.removeAllRanges();}}><X size={16}/></button></div>}
    {modal&&selection&&<div className="modal-backdrop" onKeyDown={e=>{if(e.key==='Escape'&&!annotationBusy)setModal(false);if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll('button:not(:disabled),textarea')];const first=items[0],last=items.at(-1);if(e.shiftKey&&window.document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&window.document.activeElement===last){e.preventDefault();first?.focus();}}}}><section className="annotation-modal" role="dialog" aria-modal="true" aria-labelledby="annotation-title"><div className="modal-heading"><div><span className="section-eyebrow">LEAVE A THOUGHT</span><h2 id="annotation-title">{selection.kind==='region'?'区域批注':'高亮与批注'} <small>第 {selection.page} 页</small></h2></div><button className="icon-button" disabled={annotationBusy} aria-label="关闭批注窗口" onClick={()=>setModal(false)}><X size={20}/></button></div>{selection.kind==='region'?<figure className="region-preview">{selection.preview&&<img src={selection.preview} alt={`第 ${selection.page} 页框选区域预览`}/>}<figcaption>{selection.restored?'已恢复原页与矩形坐标；浏览器草稿不保存区域图片，请核对页面标记后保存。':'批注绑定这块区域；原始 PDF 保持不变。'}</figcaption></figure>:<blockquote>{selection.quote}</blockquote>}<label className="comment-label" htmlFor="new-comment">你的想法 <span>可选</span></label><textarea autoFocus id="new-comment" aria-label="批注评论" placeholder={selection.kind==='region'?'记录这段内容、公式或图表的疑问与理解。':'为什么这句话值得留下？'} maxLength={20000} disabled={Boolean(newDraftRef.current?.attempt)} value={comment} onChange={e=>changeComment(e.target.value)}/>{newDraftRef.current?.attempt&&<p className="draft-hint">该次保存结果尚未确认，请重试保存或核对文献中的批注后放弃草稿。重试使用同一份内容，避免重复新增。</p>}{drafts.storageError&&<p role="alert" className="inline-error">浏览器草稿无法写入，请保留当前窗口并确认保存成功。</p>}<div className="modal-footer"><button className="text-button" disabled={annotationBusy} onClick={discardNewDraft}>放弃草稿</button><div className="color-picker" aria-label="高亮颜色">{[['yellow','黄色'],['green','绿色'],['pink','粉色']].map(([v,label])=><button key={v} aria-label={label} aria-pressed={color===v} className={`color-choice ${v}`} disabled={annotationBusy||Boolean(newDraftRef.current?.attempt)} onClick={()=>changeColor(v)}>{color===v&&<Check size={15}/>}</button>)}</div><button className="primary-button" disabled={annotationBusy} onClick={createAnnotation}>{annotationBusy?<LoaderCircle className="spin" size={16}/>:selection.kind==='region'?<ScanLine size={16}/>:<Highlighter size={16}/>} 保存批注</button></div></section></div>}
    <Translation ref={translationRef} documentId={current?.id} page={page} selection={selection} onModalChange={setTranslationSettingsOpen}/>
    {toast&&<div className={`toast ${toast.type}`} role={toast.type==='error'?'alert':'status'}>{toast.type==='success'&&<Check size={16}/>}<span>{toast.message}</span><button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={16}/></button></div>}
    {dragging&&<div className="drop-overlay" onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();e.stopPropagation();setDragging(false);importFiles(e.dataTransfer.files);}}><Upload size={42}/><h2>把 PDF 放到书桌上</h2><p>支持多文件，全部保存在本机</p></div>}
  </div>;
}
