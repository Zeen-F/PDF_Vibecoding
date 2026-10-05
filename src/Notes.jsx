import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Check, LoaderCircle, Save, AlertCircle } from 'lucide-react';
import { patchDocument } from './api.js';
import { mergeNotes, MAX_NOTE_LENGTH } from '../shared/notes.mjs';

function readDraft(id) {try {const value=JSON.parse(localStorage.getItem(`paperdesk-draft-${id}`)||'null');return value && typeof value.notesZh==='string' && typeof value.notesEn==='string' ? {notesZh:mergeNotes(value.notesZh,value.notesEn),notesEn:''} : null;} catch {return null;}}
const Notes = forwardRef(function Notes({document,onSaved,onError},ref) {
  const draft=useRef(readDraft(document.id));
  // Compare the merged meaning, so merely opening or flushing a legacy record
  // does not rewrite its two original fields. An actual edit saves one field.
  const initial={notesZh:mergeNotes(document.notesZh||'',document.notesEn||''),notesEn:''};
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
  const change=value=>{
    const next={notesZh:value,notesEn:''};revision.current++;latest.current=next;setNotes(next);setStatus('pending');
    try {localStorage.setItem(`paperdesk-draft-${document.id}`,JSON.stringify(next));setStorageError(false);}catch{setStorageError(true);}
    clearTimeout(timer.current);timer.current=setTimeout(()=>saveRef.current().catch(()=>{}),650);
  };
  return <div className="notes-body">
    <h2>笔记</h2>
    <p className="notes-intro">支持 Markdown，自动保存到本机。</p>
    {draft.current&&<div className="draft-hint">已恢复本机草稿。</div>}
    <label className="notes-field"><textarea aria-label="笔记" maxLength={MAX_NOTE_LENGTH} spellCheck="false" value={notes.notesZh} onChange={e=>change(e.target.value)} placeholder="记录你的想法…"/><span className="word-count">{notes.notesZh.length} 字符</span></label>
    <div className={`save-row ${status==='error'?'save-error':''}`}><span role="status">{status==='saved'?<Check size={14}/>:status==='saving'?<LoaderCircle size={14} className="spin"/>:status==='error'?<AlertCircle size={14}/>:<span className="status-dot"/>}{({saved:'已保存到本机',saving:'正在保存…',pending:'等待保存…',error:'保存失败，草稿已保留'})[status]}</span><button className="text-button" onClick={()=>save().catch(err=>onError(err.message))}><Save size={14}/> 保存</button></div>
    {storageError&&<p role="alert" className="inline-error">浏览器草稿存储已满，请点击保存并确认成功后再关闭页面。</p>}
  </div>;
});
export default Notes;
