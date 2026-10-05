import React, { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Highlighter, LoaderCircle, FileWarning, ListTree, ScanLine } from 'lucide-react';
import { prepareTextLayer, readPdfSelection } from './selection.js';
import Contents from './Contents.jsx';
import RegionSelection from './RegionSelection.jsx';
import './regions.css';
GlobalWorkerOptions.workerSrc = workerUrl;

function markMatches(container, query) {
  const spans = [...container.querySelectorAll('span')].filter(s => !s.children.length);
  spans.forEach(s => s.classList.remove('search-match'));
  if (!query.trim()) return;
  const needle = query.toLocaleLowerCase().replace(/\s+/g, '');
  let text = ''; const offsets = spans.map(span => { const start = text.length; text += span.textContent.toLocaleLowerCase().replace(/\s+/g, ''); return {span,start,end:text.length}; });
  let at = text.indexOf(needle), first;
  while (at !== -1) { for (const item of offsets) if (item.end > at && item.start < at + needle.length) { item.span.classList.add('search-match'); first ||= item.span; } at = text.indexOf(needle, at + Math.max(1,needle.length)); }
  first?.scrollIntoView({block:'nearest', inline:'nearest'});
}

export default function Reader({ document, page, onPage, annotations, selection, onSelection, selectionLocked, find, focusedAnnotation, focusTick, tocOpen, onToggleToc }) {
  const [pdf, setPdf] = useState(null), [zoom, setZoom] = useState('fit');
  const [width, setWidth] = useState(650), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [rendered, setRendered] = useState(null), [pageInput,setPageInput] = useState(String(page));
  const [regionMode, setRegionMode] = useState(false);
  const scrollRef = useRef(null), paperRef = useRef(null), canvasRef = useRef(null), textRef = useRef(null), latestFind = useRef(find), readerRef = useRef(null), tocButtonRef = useRef(null);
  const selectionLockedRef = useRef(selectionLocked), selectionRef = useRef(selection);
  selectionLockedRef.current = selectionLocked;
  selectionRef.current = selection;
  latestFind.current = find;
  useEffect(() => { setPageInput(String(page)); },[page]);
  useEffect(() => { setRegionMode(false); }, [document.id]);
  useEffect(() => {
    const el = scrollRef.current;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    observer.observe(el); return () => observer.disconnect();
  },[]);
  useEffect(() => {
    let alive = true;
    setPdf(null); setError(''); setBusy(true); setRendered(null);
    const task = getDocument({url:`/api/documents/${document.id}/file`, cMapUrl:'/pdf-assets/cmaps/', cMapPacked:true, standardFontDataUrl:'/pdf-assets/standard_fonts/', wasmUrl:'/pdf-assets/wasm/', isEvalSupported:false});
    task.promise.then(value => { if(alive) setPdf(value); }).catch(err => { if(alive) { setError(`无法打开 PDF：${err.message}`); setBusy(false); } });
    return () => { alive=false; task.destroy().catch(()=>{}); };
  },[document.id]);
  useEffect(() => {
    if(!pdf) return;
    let cancelled = false, renderTask, textLayer;
    setBusy(true); setError(''); setRendered(null);
    const draft = selectionRef.current;
    const keepRegion = draft?.kind === 'region' && draft.documentId === document.id && draft.page === page;
    if(!selectionLockedRef.current && !keepRegion) onSelection(null);
    (async()=>{
      const p = await pdf.getPage(page);
      if(cancelled) return;
      const base = p.getViewport({scale:1});
      const scale = zoom === 'fit' ? Math.min(1.65,width/base.width) : Number(zoom);
      const viewport = p.getViewport({scale});
      const container = paperRef.current;
      container.style.width = `${viewport.width}px`; container.style.height = `${viewport.height}px`;
      container.style.setProperty('--user-unit',String(viewport.userUnit || 1));
      container.style.setProperty('--total-scale-factor',String(scale * (viewport.userUnit || 1)));
      container.style.setProperty('--scale-round-x','1px'); container.style.setProperty('--scale-round-y','1px');
      const canvas = window.document.createElement('canvas');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width*dpr); canvas.height = Math.floor(viewport.height*dpr);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-label',`PDF 第 ${page} 页`);
      canvasRef.current.replaceChildren(canvas); textRef.current.replaceChildren();
      renderTask=p.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});
      await renderTask.promise;
      if(cancelled) return;
      const content = await p.getTextContent();
      if(cancelled) return;
      textLayer = new TextLayer({textContentSource:content,container:textRef.current,viewport});
      await textLayer.render();
      if(cancelled) return;
      prepareTextLayer(textRef.current, {rotation:viewport.rotation, paperBounds:container.getBoundingClientRect()});
      const end=window.document.createElement('div');
      end.className='endOfContent';textRef.current.append(end);
      setRendered({id:document.id,page}); setBusy(false);
      markMatches(textRef.current,latestFind.current || '');
    })().catch(err=>{ if(!cancelled && err.name !== 'RenderingCancelledException') {setError(`页面加载失败：${err.message}`);setBusy(false);} });
    return ()=>{cancelled=true;renderTask?.cancel();textLayer?.cancel();};
  },[pdf,page,zoom,width,document.id]);
  useEffect(()=>{if(rendered) markMatches(textRef.current,find || '');},[find,rendered]);
  useEffect(()=>{
    if(!focusedAnnotation || !rendered) return;
    const target=[...paperRef.current.querySelectorAll('[data-annotation]')].find(el=>el.dataset.annotation===focusedAnnotation);
    target?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  },[focusedAnnotation,focusTick,rendered]);
  useEffect(()=>{
    if(busy || rendered?.id!==document.id || rendered?.page!==page || selectionLocked || regionMode) return;
    const owner=window.document,layer=textRef.current;
    let frame=0;
    const capture=()=>{
      frame=0;
      const result=readPdfSelection(layer,paperRef.current);
      onSelection(result ? {documentId:document.id,page,kind:'text',...result} : null);
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(capture);};
    const down=event=>{if(layer.contains(event.target))layer.classList.add('selecting');};
    const finish=()=>{layer.classList.remove('selecting');schedule();};
    owner.addEventListener('selectionchange',schedule);
    owner.addEventListener('pointerdown',down);
    owner.addEventListener('pointerup',finish);
    owner.addEventListener('keyup',finish);
    window.addEventListener('blur',finish);
    schedule();
    return()=>{
      cancelAnimationFrame(frame);layer.classList.remove('selecting');
      owner.removeEventListener('selectionchange',schedule);
      owner.removeEventListener('pointerdown',down);
      owner.removeEventListener('pointerup',finish);
      owner.removeEventListener('keyup',finish);
      window.removeEventListener('blur',finish);
    };
  },[busy,rendered,selectionLocked,regionMode,document.id,page,onSelection]);
  const copySelection=event=>{
    if(regionMode) return;
    const result=readPdfSelection(textRef.current,paperRef.current);
    if(result && event.clipboardData){event.clipboardData.setData('text/plain',result.quote);event.preventDefault();}
  };
  const gotoInput = () => {const next=Number(pageInput);if(Number.isInteger(next)&&next>=1&&next<=document.pageCount) onPage(next);else setPageInput(String(page));};
  const ready=rendered?.id===document.id && rendered.page===page;
  const closeToc = () => { onToggleToc(false); tocButtonRef.current?.focus(); };
  const jumpFromToc = next => { onPage(next); if (readerRef.current.clientWidth <= 700) closeToc(); };
  const toggleRegion = () => {
    if(busy || selectionLocked) return;
    window.getSelection()?.removeAllRanges();
    textRef.current?.classList.remove('selecting');
    onSelection(null);
    setRegionMode(value => !value);
  };
  return <section className={`reader ${regionMode ? 'region-mode' : ''}`} aria-label="PDF 阅读器" ref={readerRef}>
    <div className="reader-toolbar">
      <div className="reader-navigation"><button ref={tocButtonRef} className={`contents-toggle ${tocOpen ? 'selected' : ''}`} aria-label={tocOpen ? '收起目录' : '展开目录'} aria-expanded={tocOpen} onClick={() => onToggleToc(!tocOpen)}><ListTree size={16}/><span>目录</span></button><div className="pager"><button className="icon-button" aria-label="上一页" disabled={page<=1||busy} onClick={()=>onPage(page-1)}><ChevronLeft size={17}/></button><input aria-label="页码" type="number" min="1" max={document.pageCount} value={pageInput} onChange={e=>setPageInput(e.target.value)} onBlur={gotoInput} onKeyDown={e=>{if(e.key==='Enter')gotoInput();}}/><span>/ {document.pageCount}</span><button className="icon-button" aria-label="下一页" disabled={page>=document.pageCount||busy} onClick={()=>onPage(page+1)}><ChevronRight size={17}/></button></div></div>
      <span className="reader-hint">{regionMode ? <><ScanLine size={14}/> 拖动框选区域 · Esc 取消</> : <><Highlighter size={14}/> 选中文字，留下想法</>}</span>
      <div className="reader-tools"><button className="region-toggle" aria-label="区域批注" aria-pressed={regionMode} disabled={busy || selectionLocked} onClick={toggleRegion}><ScanLine size={16}/><span>区域批注</span></button><select aria-label="阅读缩放" value={zoom} onChange={e=>setZoom(e.target.value)}><option value="fit">适合宽度</option><option value="0.8">80%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></div>
    </div>
    <div className="reader-body">
      {tocOpen && <Contents key={document.id} document={document} page={page} onJump={jumpFromToc} onClose={closeToc}/>}
    <div className="pdf-scroll" ref={scrollRef}>
      {busy&&<div className="reader-status" role="status"><LoaderCircle className="spin" size={17}/> 正在排版页面…</div>}
      {error&&<div className="reader-error" role="alert"><FileWarning/><p>{error}</p><button onClick={()=>window.location.reload()}>重新加载</button></div>}
      <div className={`pdf-paper ${busy?'is-loading':''}`} ref={paperRef} data-page={page}>
        <div ref={canvasRef}/><div className="textLayer" ref={textRef} tabIndex={0} aria-label="PDF 本页文字" onCopy={copySelection}/>
        {ready&&<div className="highlight-layer" aria-hidden="true">{annotations.filter(a=>a.page===page).flatMap(a=>a.rects.map((r,i)=><span key={`${a.id}-${i}`} className={`highlight-rect ${a.color} ${a.kind==='region'?'region-annotation':''} ${focusedAnnotation===a.id?'focused':''}`} data-annotation={a.id} style={{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`}}/>))}</div>}
        {ready && regionMode && <RegionSelection key={`${document.id}:${page}`} enabled={!selectionLocked && !busy} documentId={document.id} page={page} canvasRef={canvasRef} selection={selection} onSelection={onSelection}/>}
      </div>
      {!document.textAvailable&&<p className="scan-notice">这份 PDF 没有可提取的文字。点击“区域批注”，拖动框选图片、公式或文字区域并添加评论；仍可写双语笔记。区域批注不会识别图片中的文字。</p>}
      <div className="page-footer">{document.filename} <span>·</span> {page} / {document.pageCount}</div>
    </div>
    </div>
  </section>;
}
