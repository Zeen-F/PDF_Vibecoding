import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Check, LoaderCircle, Save, AlertCircle } from 'lucide-react';
import { patchDocument } from './api.js';

function readDraft(id) {try {const value=JSON.parse(localStorage.getItem(`paperdesk-draft-${id}`)||'null');return value && typeof value.notesZh==='string' && typeof value.notesEn==='string' ? {notesZh:value.notesZh,notesEn:value.notesEn} : null;} catch {return null;}}
const Notes = forwardRef(function Notes({document,onSaved,onError},ref) {
  const draft=useRef(readDraft(document.id));
  const initial={notesZh:document.notesZh||'',notesEn:document.notesEn||''};
  const [notes,setNotes]=useState(draft.current || initial),[status,setStatus]=useState(draft.current?'pending':'saved');
  const latest=useRef(notes), saved=useRef(initial), timer=useRef(null), queue=useRef(Promise.resolve()), alive=useRef(true), revision=useRef(0);
  const [storageError,setStorageError]=useState(false);
  const save=()=>{
    clearTimeout(timer.current);
    const snapshot={...latest.current}, atRevision=revision.current;
    if(alive.current)setStatus('saving');
    const work=queue.current.catch(()=>{}).then(async()=>{
      // Compare only after older writes have settled; an edit can return to an older value.
      let result;
      if(snapshot.notesZh!==saved.current.notesZh || snapshot.notesEn!==saved.current.notesEn){
        result=await patchDocument(document.id,snapshot);
        saved.current=snapshot;onSaved(result.document);
      }
      if(revision.current===atRevision){
        try {localStorage.removeItem(`paperdesk-draft-${document.id}`);}catch{}
        if(alive.current)setStatus('saved');
      }
      return result;
    }).catch(err=>{if(alive.current && revision.current===atRevision)setStatus('error');throw err;});
    queue.current=work;return work;
  };
  const saveRef=useRef(save);saveRef.current=save;
  useImperativeHandle(ref,()=>({flush:()=>saveRef.current()}));
  useEffect(()=>{
    alive.current=true;
    if(draft.current) timer.current=setTimeout(()=>saveRef.current().catch(()=>{}),200);
    const warn=e=>{if(latest.current.notesZh!==saved.current.notesZh||latest.current.notesEn!==saved.current.notesEn){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',warn);
    return()=>{alive.current=false;window.removeEventListener('beforeunload',warn);clearTimeout(timer.current);saveRef.current().catch(()=>{});};
  },[]);
  const change=(field,value)=>{
    const next={...latest.current,[field]:value};revision.current++;latest.current=next;setNotes(next);setStatus('pending');
    try {localStorage.setItem(`paperdesk-draft-${document.id}`,JSON.stringify(next));setStorageError(false);}catch{setStorageError(true);}
    clearTimeout(timer.current);timer.current=setTimeout(()=>saveRef.current().catch(()=>{}),650);
  };
  return <div className="notes-body">
    <div className="section-eyebrow">THINK IN TWO LANGUAGES</div>
    <h2>让理解，留下来。</h2>
    <p className="notes-intro">两栏独立编辑，支持 Markdown。<br/>自动保存到本机，不调用翻译服务。</p>
    {draft.current&&<div className="draft-hint">已恢复本机草稿。</div>}
    <div className="bilingual-grid">
      <label className="note-column"><span className="note-label"><b>中文笔记</b><span>ZH</span></span><textarea aria-label="中文笔记" maxLength={250000} spellCheck="false" value={notes.notesZh} onChange={e=>change('notesZh',e.target.value)} placeholder={'## 核心问题\n这篇论文研究什么？\n\n## 我的理解\n记录方法、证据和疑问。'}/><span className="word-count">{notes.notesZh.length} 字符</span></label>
      <label className="note-column"><span className="note-label"><b>English notes</b><span>EN</span></span><textarea aria-label="English notes" maxLength={250000} value={notes.notesEn} onChange={e=>change('notesEn',e.target.value)} placeholder={'## Key question\nWhat does this paper ask?\n\n## My understanding\nMethods, evidence, and open questions.'}/><span className="word-count">{notes.notesEn.length} characters</span></label>
    </div>
    <div className={`save-row ${status==='error'?'save-error':''}`}><span role="status">{status==='saved'?<Check size={14}/>:status==='saving'?<LoaderCircle size={14} className="spin"/>:status==='error'?<AlertCircle size={14}/>:<span className="status-dot"/>}{({saved:'已保存到本机',saving:'正在保存…',pending:'等待保存…',error:'保存失败，草稿已保留'})[status]}</span><button className="text-button" onClick={()=>save().catch(err=>onError(err.message))}><Save size={14}/> 保存</button></div>
    {storageError&&<p role="alert" className="inline-error">浏览器草稿存储已满，请点击保存并确认成功后再关闭页面。</p>}
    <div className="note-tip"><span>READING PRACTICE / 01</span><p>把结论和证据分开记录。<br/>对值得回看的句子，选中并添加批注。</p></div>
  </div>;
});
export default Notes;
