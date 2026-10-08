import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from './api.js';
import './bookmarks.css';

export default function Bookmarks({ document, page, active, disabled, onJump, onClose, onStateChange }) {
  const [bookmarks,setBookmarks]=useState([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
  const [edit,setEdit]=useState(null),[pending,setPending]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const mounted=useRef(true),sequence=useRef(0),controller=useRef(null),working=useRef(false);
  const editRef=useRef(null),pendingRef=useRef(null),callback=useRef(onStateChange);
  callback.current=onStateChange;
  const emit=()=>callback.current?.({documentId:document.id,busy:working.current,dirty:Boolean(editRef.current||pendingRef.current)});
  const changeEdit=value=>{editRef.current=value;setEdit(value);emit();};
  const changePending=value=>{pendingRef.current=value;setPending(value);emit();};
  const invalidate=()=>{++sequence.current;controller.current?.abort();controller.current=null;if(mounted.current)setLoading(false);};
  const begin=()=>{if(working.current||disabled)return false;working.current=true;setBusy(true);invalidate();setError('');setMessage('');emit();return true;};
  const finish=()=>{working.current=false;if(mounted.current){setBusy(false);emit();}};
  const applyBookmark=bookmark=>{
    if(bookmark?.documentId!==document.id)throw new Error('书签保存结果不属于当前文献，请重新读取确认。');
    setBookmarks(items=>[...items.filter(item=>item.id!==bookmark.id&&item.page!==bookmark.page),bookmark].sort((a,b)=>a.page-b.page));
  };
  const read=async()=>{
    const version=++sequence.current;controller.current?.abort();
    const request=new AbortController();controller.current=request;setLoading(true);
    try{
      const data=await api(`/documents/${document.id}/bookmarks`,{signal:request.signal});
      if(!mounted.current||version!==sequence.current)return null;
      setBookmarks(data.bookmarks);return data.bookmarks;
    }finally{if(mounted.current&&version===sequence.current){setLoading(false);controller.current=null;}}
  };
  const reload=async()=>{
    if(working.current||disabled)return;
    setError('');setMessage('');
    try{
      const items=await read();if(!items)return;
      const attempt=pendingRef.current;
      if(attempt){
        const found=attempt.kind==='add'?items.find(item=>item.page===attempt.page):items.find(item=>item.id===attempt.bookmark.id);
        if(attempt.kind==='add'&&found){changePending(null);setMessage(`已确认保存：PDF 第 ${found.page} 页。`);}
        else if(attempt.kind==='delete'&&!found){changePending(null);setMessage(`已确认删除：PDF 第 ${attempt.bookmark.page} 页。`);}
        else if(attempt.kind==='delete'&&found.updatedAt!==attempt.bookmark.updatedAt){changePending(null);setError('此书签已被其他窗口修改，已读取最新名称。请核对后再决定是否删除。');}
        else setMessage('已读取最新书签；操作仍未确认，可重试。');
      }
      const draft=editRef.current;
      if(draft){
        const latest=items.find(item=>item.id===draft.id);
        if(draft.uncertain&&latest?.title===draft.title.trim()){
          changeEdit(null);setMessage(`已确认保存名称：PDF 第 ${latest.page} 页。`);
        }else if(latest){
          changeEdit({...draft,expectedUpdatedAt:latest.updatedAt,latestTitle:latest.title,conflict:false,uncertain:false,missing:false});
          setMessage('已读取最新名称，输入的名称仍保留。请核对后保存或取消。');
        }else{
          changeEdit({...draft,missing:true});setError('此书签已被删除，输入的名称仍保留。请复制需要的内容，或取消重命名。');
        }
      }
    }catch(err){if(err.name!=='AbortError'&&mounted.current)setError(`书签读取失败：${err.message}`);}
  };
  useEffect(()=>{
    mounted.current=true;emit();
    return()=>{mounted.current=false;invalidate();};
  },[document.id]);
  useEffect(()=>{if(active)void reload();},[active,document.id]);
  const add=async(attempt)=>{
    const target=attempt?.page??page;
    if(editRef.current||(!attempt&&pendingRef.current)||!begin())return;
    const operation={kind:'add',page:target};changePending(operation);
    try{
      if(attempt){
        const items=await read();if(!items)return;
        const existing=items.find(item=>item.page===target);
        if(existing){changePending(null);setMessage(`已确认保存：PDF 第 ${target} 页。`);return;}
      }
      invalidate();
      const result=await api(`/documents/${document.id}/bookmarks`,{method:'POST',body:JSON.stringify({page:target})});
      if(!mounted.current)return;invalidate();applyBookmark(result.bookmark);changePending(null);setMessage(`书签已保存：PDF 第 ${target} 页。`);
    }catch(err){if(mounted.current)setError(`添加未确认保存，当前页仍为 PDF 第 ${target} 页：${err.message}`);}
    finally{finish();}
  };
  const rename=async()=>{
    const draft=editRef.current;
    if(!draft||draft.conflict||draft.missing||!draft.title.trim()||!begin())return;
    try{
      invalidate();
      const result=await api(`/documents/${document.id}/bookmarks/${draft.id}`,{method:'PATCH',body:JSON.stringify({title:draft.title.trim(),expectedUpdatedAt:draft.expectedUpdatedAt})});
      if(!mounted.current)return;invalidate();applyBookmark(result.bookmark);changeEdit(null);setMessage(`名称已保存：PDF 第 ${draft.page} 页。`);
    }catch(err){
      if(mounted.current){changeEdit({...draft,conflict:err.status===409,uncertain:!err.status||err.status>=500});setError(err.status===409?`名称已在其他窗口修改，输入仍保留。请读取最新书签后核对：${err.message}`:`名称未确认保存，输入仍保留：${err.message}`);}
    }finally{finish();}
  };
  const remove=async(bookmark,retry=false)=>{
    if(editRef.current||(!retry&&pendingRef.current)||!begin())return;
    changePending({kind:'delete',bookmark});
    try{
      if(retry){
        const items=await read();if(!items)return;
        const latest=items.find(item=>item.id===bookmark.id);
        if(!latest){changePending(null);setMessage(`已确认删除：PDF 第 ${bookmark.page} 页。`);return;}
        if(latest.updatedAt!==bookmark.updatedAt){changePending(null);setError('此书签已被其他窗口修改，已读取最新名称。请核对后再决定是否删除。');return;}
      }
      invalidate();
      await api(`/documents/${document.id}/bookmarks/${bookmark.id}`,{method:'DELETE',body:JSON.stringify({expectedUpdatedAt:bookmark.updatedAt})});
      if(!mounted.current)return;invalidate();setBookmarks(items=>items.filter(item=>item.id!==bookmark.id));changePending(null);setMessage(`已删除 PDF 第 ${bookmark.page} 页的书签。`);
    }catch(err){
      if(mounted.current){if(err.status===409)changePending(null);setError(err.status===409?`书签已在其他窗口修改，请读取最新书签后核对：${err.message}`:`删除未确认，原书签仍显示。请重新读取或重试：${err.message}`);}
    }finally{finish();}
  };
  const current=bookmarks.find(item=>item.page===page);
  return <section className="bookmarks-panel" aria-label="个人书签" hidden={!active}>
    <div className="contents-heading"><div><span className="section-eyebrow">BOOKMARKS</span><h2><Bookmark size={17}/> 个人书签</h2></div><button className="icon-button" aria-label="关闭书签" disabled={busy||disabled} onClick={onClose}><X size={17}/></button></div>
    <p className="bookmarks-intro">记录 PDF 实际页码，不修改原 PDF。</p>
    <div className="bookmarks-actions"><button className="mini-primary" aria-label="添加当前页书签" disabled={loading||busy||disabled||Boolean(edit||pending||current)} onClick={()=>void add()}>{busy?<LoaderCircle size={14} className="spin"/>:<Plus size={14}/>} {current?'此页已有书签':`添加当前页 · ${page}`}</button><button className="icon-button" aria-label="刷新书签" title="重新读取书签" disabled={loading||busy||disabled} onClick={()=>void reload()}><RefreshCw size={14}/></button></div>
    {error&&<div className="bookmarks-error" role="alert"><p>{error}</p><button className="text-button" disabled={loading||busy||disabled} onClick={()=>void reload()}>读取最新书签</button></div>}
    {message&&<p className="bookmarks-message" role="status">{message}</p>}
    {pending&&!busy&&<div className="bookmarks-pending"><p>请确认 PDF 第 {pending.kind==='add'?pending.page:pending.bookmark.page} 页的{pending.kind==='add'?'添加':'删除'}结果后，再切换文献。</p><button className="text-button" disabled={disabled||loading} onClick={()=>void (pending.kind==='add'?add(pending):remove(pending.bookmark,true))}>{pending.kind==='add'?'重试添加书签':'重试删除书签'}</button></div>}
    {edit&&<form className="bookmark-editor" onSubmit={event=>{event.preventDefault();void rename();}}><label>PDF 第 {edit.page} 页<input autoFocus aria-label={`书签名称，PDF 第 ${edit.page} 页`} value={edit.title} maxLength={200} disabled={busy||disabled} onChange={event=>changeEdit({...editRef.current,title:event.target.value})}/></label>{edit.latestTitle!==undefined&&<p>已保存名称：{edit.latestTitle}</p>}<div><button className="text-button" type="button" disabled={busy||disabled} onClick={()=>{changeEdit(null);setError('');setMessage('已取消重命名。');}}>取消重命名</button><button className="mini-primary" disabled={busy||disabled||loading||edit.conflict||edit.missing||!edit.title.trim()}><Check size={13}/> 保存书签名称</button></div></form>}
    <nav className="bookmarks-list" aria-label="页面书签">{loading&&<p className="bookmarks-message" role="status">正在读取书签…</p>}{bookmarks.map(bookmark=><div className={`bookmark-row ${bookmark.page===page?'current':''}`} key={bookmark.id} data-bookmark-id={bookmark.id} data-bookmark-page={bookmark.page}><button className="bookmark-jump" aria-label={`书签：${bookmark.title}，PDF 第 ${bookmark.page} 页`} aria-current={bookmark.page===page?'location':undefined} disabled={busy||disabled||Boolean(edit||pending)} onClick={()=>onJump(bookmark.page)}><span>{bookmark.title}</span><small>PDF 第 {bookmark.page} 页</small></button><div className="bookmark-row-actions"><button className="icon-button" aria-label={`重命名书签：${bookmark.title}，PDF 第 ${bookmark.page} 页`} disabled={busy||disabled||Boolean(edit||pending)} onClick={()=>{setError('');setMessage('');changeEdit({id:bookmark.id,page:bookmark.page,title:bookmark.title,expectedUpdatedAt:bookmark.updatedAt,latestTitle:bookmark.title});}}><Pencil size={13}/></button><button className="icon-button" aria-label={`删除书签：${bookmark.title}，PDF 第 ${bookmark.page} 页`} disabled={busy||disabled||Boolean(edit||pending)} onClick={()=>void remove(bookmark)}><Trash2 size={13}/></button></div></div>)}{!loading&&!bookmarks.length&&!error&&<p className="bookmarks-empty">还没有个人书签。<br/>打开想留下的位置，再添加当前页。</p>}</nav>
  </section>;
}
