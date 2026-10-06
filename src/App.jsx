import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Plus, Search, Upload, FileText, ArrowUpRight, Download, X, Highlighter, MessageSquare, Check, Trash2, Pencil, Library, LockKeyhole, LoaderCircle, ArrowRight, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen, ScanLine } from 'lucide-react';
import Reader from './Reader.jsx';
import Notes from './Notes.jsx';
import { api, patchDocument } from './api.js';
import { readDeepLink, useCodexContext } from './codex-context.js';
import { buildChatgptPrompt, createChatgptHandoffSnapshot, DEFAULT_CHATGPT_QUESTION, MAX_CHATGPT_QUESTION_LENGTH, selectionPngBlob } from './chatgpt-handoff.js';
import './codex.css';
import './chatgpt.css';

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
    {annotation.kind==='region'?<button className="region-card-link" aria-label="框选区域" onClick={()=>onJump(annotation)}><ScanLine size={16}/><span>框选区域<small>回到页面查看标记</small></span><ArrowUpRight size={14}/></button>:<blockquote onClick={()=>onJump(annotation)}>{annotation.quote}</blockquote>}
    {editing?<div className="annotation-edit"><textarea aria-label="编辑批注内容" value={comment} maxLength={20000} onChange={e=>setComment(e.target.value)}/><div className="button-row"><button className="text-button" onClick={()=>setEditing(false)}>取消</button><button disabled={busy} className="mini-primary" onClick={async()=>{setBusy(true);if(await onUpdate(annotation.id,{comment}))setEditing(false);setBusy(false);}}>保存</button></div></div>:<p className="annotation-comment">{annotation.comment||(annotation.kind==='region'?'仅标记区域，暂无评论':'仅高亮，暂无评论')}</p>}
    {confirm&&<div className="delete-confirm">删除这条批注？<button className="text-button" onClick={()=>setConfirm(false)}>取消</button><button className="text-button danger" disabled={busy} onClick={async()=>{setBusy(true);await onDelete(annotation.id);setBusy(false);setConfirm(false);}}>删除</button></div>}
  </article>;
}

const CHATGPT_RUNNING=new Set(['queued','connecting','uploading','sending','waiting']);
const CHATGPT_STATES={queued:'排队中',connecting:'正在连接 ChatGPT',uploading:'正在上传选区图片',sending:'正在发送问题',waiting:'正在等待回答',needs_user:'需要你完成连接',completed:'回答已收到',failed:'任务未完成',uncertain:'发送结果不确定'};
async function chatgptRequest(path,options={}) {
  const response=await fetch(`/api/chatgpt/jobs${path}`,{...options,headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||`任务请求未完成 (${response.status})`);error.status=response.status;throw error;}
  return data.job;
}
function ChatgptAnswers({records,onClose,onResume,onRefresh,onRetry}) {
  const [copied,setCopied]=useState('');
  const copy=async(record)=>{try{await navigator.clipboard.writeText(record.job.response);setCopied(record.requestId);}catch{const textarea=window.document.getElementById(`answer-${record.requestId}`);textarea?.focus();textarea?.select();setCopied('manual');}};
  return <div className="chatgpt-handoff-backdrop" onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();onClose();}
    if(event.key==='Tab'){const items=[...event.currentTarget.querySelectorAll('button:not(:disabled),textarea')],first=items[0],last=items.at(-1);if(event.shiftKey&&window.document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&window.document.activeElement===last){event.preventDefault();first?.focus();}}
  }}><section className="chatgpt-handoff-dialog" role="dialog" aria-modal="true" aria-label="ChatGPT 回答"><div className="chatgpt-handoff-heading"><h2>ChatGPT 回答</h2><button autoFocus className="icon-button" aria-label="关闭 ChatGPT 回答" onClick={onClose}><X size={20}/></button></div><p className="chatgpt-handoff-boundary">回答不会自动写入笔记。关闭窗口或翻页后，可通过“查看回答”继续查看当前文献的任务。</p>
    {records.map(record=><article key={record.requestId} className="chatgpt-answer-card" data-job-id={record.requestId}><p className="chatgpt-handoff-source"><strong>{record.title}</strong> · PDF 第 {record.body.page} 页</p><p className="chatgpt-answer-question">{record.body.question}</p><p className="chatgpt-handoff-status" role="status">{record.busy==='submitting'?'正在确认提交…':CHATGPT_STATES[record.job?.state]||'尚未确认任务状态'}{record.job?.message?`：${record.job.message}`:''}</p>{record.error&&<p className="chatgpt-handoff-status" data-error="true" role="alert">{record.error}</p>}
      {record.job?.state==='uncertain'&&<p className="chatgpt-handoff-boundary">请先核对 ChatGPT 会话。此任务不会自动重新发送。</p>}
      {typeof record.job?.response==='string'&&record.job.response&&<><textarea id={`answer-${record.requestId}`} aria-label="ChatGPT 回答" readOnly rows={12} value={record.job.response}/><button className="secondary-button" onClick={()=>copy(record)}>复制回答</button></>}
      <div className="chatgpt-handoff-actions">{record.job?.state==='needs_user'&&record.job.canResume&&<button className="primary-button" disabled={Boolean(record.busy)} onClick={()=>onResume(record.requestId)}>我已完成，继续连接</button>}<button className="secondary-button" disabled={Boolean(record.busy)} onClick={()=>onRefresh(record.requestId)}>刷新任务状态</button>{!record.job&&record.lookupNotFound&&<button className="secondary-button" disabled={Boolean(record.busy)} onClick={()=>onRetry(record.requestId)}>重新确认提交</button>}</div>
      {copied===record.requestId&&<p role="status">回答已复制。</p>}
    </article>)}{copied==='manual'&&<p role="status">复制未完成，已选中回答，请手动复制。</p>}
  </section></div>;
}
function ChatgptHandoff({snapshot,onClose,copying,onCopyPrompt,onSubmit,submission,onViewAnswers}) {
  const [question,setQuestion]=useState(DEFAULT_CHATGPT_QUESTION);
  const submitted=useRef(false);
  const [status,setStatus]=useState(null);
  const prepared=useRef(null),questionInput=useRef(null),active=useRef(false),copySequence=useRef(0),copyPending=useRef(false);
  const downloadUrls=useRef(new Map());
  const prompt=buildChatgptPrompt(snapshot,question);
  useEffect(()=>{
    active.current=true;questionInput.current?.focus();
    return()=>{active.current=false;copySequence.current++;for(const [url,timer] of downloadUrls.current){clearTimeout(timer);URL.revokeObjectURL(url);}downloadUrls.current.clear();};
  },[]);
  const close=()=>{active.current=false;copySequence.current++;onClose();};
  const copy=async()=>{
    if(copying||copyPending.current||!question.trim())return;
    const sequence=++copySequence.current;
    copyPending.current=true;
    setStatus(null);
    try{
      await onCopyPrompt(prompt);
      if(active.current&&copySequence.current===sequence)setStatus({message:'提问已复制。请在 ChatGPT 粘贴，核对后自行发送。'});
    }catch{
      if(active.current&&copySequence.current===sequence){prepared.current?.focus();prepared.current?.select();setStatus({error:true,message:'复制未完成，已选中准备好的问题，请手动复制。'});}
    }finally{copyPending.current=false;}
  };
  const saveImage=()=>{
    try{
      const url=URL.createObjectURL(selectionPngBlob(snapshot.preview));
      const anchor=window.document.createElement('a');
      anchor.href=url;anchor.download=`paperdesk-page-${snapshot.page}-selection.png`;
      window.document.body.append(anchor);anchor.click();anchor.remove();
      const timer=setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.current.delete(url);},2000);
      downloadUrls.current.set(url,timer);
    }catch{setStatus({error:true,message:'图片下载未完成，请关闭窗口后重新框选。'});}
  };
  const trapFocus=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key!=='Tab')return;
    const items=[...event.currentTarget.querySelectorAll('button:not(:disabled),a[href],textarea:not(:disabled),summary')].filter(item=>item.getClientRects().length);
    const first=items[0],last=items.at(-1),focused=window.document.activeElement;
    if(event.shiftKey&&(focused===first||!items.includes(focused))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(focused===last||!items.includes(focused))){event.preventDefault();first?.focus();}
  };
  return <div className="chatgpt-handoff-backdrop" onKeyDown={trapFocus}>
    <section className="chatgpt-handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="chatgpt-handoff-title" aria-describedby="chatgpt-handoff-instructions">
      <div className="chatgpt-handoff-heading"><div><span className="section-eyebrow">TAKE A QUESTION WITH YOU</span><h2 id="chatgpt-handoff-title">ChatGPT 提问准备</h2></div><button className="icon-button" aria-label="关闭 ChatGPT 提问准备" onClick={close}><X size={20}/></button></div>
      <p className="chatgpt-handoff-source"><strong>{snapshot.title}</strong> · PDF 第 {snapshot.page} 页</p>
      {snapshot.kind==='region'?<figure className="chatgpt-handoff-preview"><img src={snapshot.preview} alt={`第 ${snapshot.page} 页框选区域预览`}/><figcaption>提问只携带这里预览的选区图片。</figcaption></figure>:<blockquote className="chatgpt-handoff-quote">{snapshot.text}</blockquote>}
      <label htmlFor="chatgpt-question">向 ChatGPT 提问</label>
      <textarea id="chatgpt-question" ref={questionInput} rows={3} disabled={Boolean(submission)} maxLength={MAX_CHATGPT_QUESTION_LENGTH} value={question} onChange={event=>{copySequence.current++;setQuestion(event.target.value);setStatus(null);}}/>
      <p id="chatgpt-handoff-instructions" className="chatgpt-handoff-instructions">确认后自动连接普通 ChatGPT，提交这个问题和选区，并在纸间显示回答。登录、验证码或模型设置需要时会停下来，由你处理后继续。提交后关闭窗口不会取消任务，可点“查看回答”继续查看。</p>
      <div className="chatgpt-handoff-actions"><button className="primary-button" disabled={!question.trim()||Boolean(submission)} onClick={()=>{if(submitted.current)return;submitted.current=true;onSubmit(snapshot,question.trim());}}>向 ChatGPT 提问</button>{submission&&<button className="secondary-button" onClick={onViewAnswers}>查看回答</button>}</div>
      {submission&&<p className="chatgpt-handoff-status" role="status">{submission.error||CHATGPT_STATES[submission.job?.state]||'正在确认提交…'}</p>}
      {submission?.job?.state==='completed'&&typeof submission.job.response==='string'&&<section><label htmlFor="chatgpt-inline-response">ChatGPT 回答预览</label><textarea id="chatgpt-inline-response" aria-label="ChatGPT 回答预览" rows={8} readOnly value={submission.job.response}/></section>}
      <p className="chatgpt-handoff-boundary">问题发往普通 ChatGPT，不发到当前 Codex 对话。回答不会自动保存到笔记。</p>
      <details className="chatgpt-manual"><summary>手动备用方式</summary>
      <label htmlFor="chatgpt-prepared">准备给 ChatGPT 的问题</label>
      <textarea id="chatgpt-prepared" ref={prepared} rows={6} readOnly value={prompt}/>
      <p className="chatgpt-handoff-instructions">仅在需要手动处理时，复制提问{snapshot.kind==='region'?'并保存选区图片':''}，打开 ChatGPT 后粘贴、核对并发送。若任务发送结果不确定，请先查看原会话，避免重复发送。</p>
      <p className="chatgpt-handoff-boundary">请选择普通聊天（Chat）；ChatGPT Work 与 Codex 共用额度。答案需要自行贴入纸间笔记。</p>
      <div className="chatgpt-handoff-actions"><button className="primary-button" disabled={copying||!question.trim()} onClick={copy}>{copying?(copyPending.current?'正在复制…':'等待上次复制…'):'复制 ChatGPT 提问'}</button>{snapshot.kind==='region'&&<button className="secondary-button" onClick={saveImage}><Download size={15}/>保存选区图片</button>}<a className="secondary-button" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">打开 ChatGPT <ArrowUpRight size={15}/></a></div>
      <p className="chatgpt-handoff-status" role="status" data-error={status?.error||undefined}>{status?.message||''}</p>
      </details>
    </section>
  </div>;
}

export default function App() {
  const [documents,setDocuments]=useState([]),[current,setCurrent]=useState(null),[annotations,setAnnotations]=useState([]),[page,setPage]=useState(1);
  const [tab,setTab]=useState('notes'),[showNotes,setShowNotes]=useState(true),[query,setQuery]=useState(''),[results,setResults]=useState([]),[searching,setSearching]=useState(false),[find,setFind]=useState('');
  const [tocOpen,setTocOpen]=useState(false);
  const [notesState,setNotesState]=useState({documentId:null,dirty:false});
  const [showLibrary,setShowLibrary]=useState(()=>{try{return localStorage.getItem('paperdesk-library-collapsed')!=='true';}catch{return true;}});
  const librarySearchPending=useRef(false);
  const [selection,setSelection]=useState(null),[modal,setModal]=useState(false),[comment,setComment]=useState(''),[color,setColor]=useState('yellow'),[annotationBusy,setAnnotationBusy]=useState(false),[focused,setFocused]=useState(null),[focusTick,setFocusTick]=useState(0);
  const [handoff,setHandoff]=useState(null);
  const [chatgptJobs,setChatgptJobs]=useState([]),[answersOpen,setAnswersOpen]=useState(false),[handoffRequestId,setHandoffRequestId]=useState(null);
  const chatgptRecords=useRef(new Map()),chatgptMounted=useRef(true);
  const updateChatgptRecord=useCallback((requestId,patch)=>{const record=chatgptRecords.current.get(requestId);if(!record)return;chatgptRecords.current.set(requestId,{...record,...patch});if(chatgptMounted.current)setChatgptJobs([...chatgptRecords.current.values()]);},[]);
  const acceptChatgptJob=useCallback((requestId,job)=>{const record=chatgptRecords.current.get(requestId);if(!record||job?.id!==requestId||job.documentId!==record.body.documentId||job.page!==record.body.page)throw new Error('任务返回的文献或页码不一致，已保留原提问。');updateChatgptRecord(requestId,{job,error:null,lookupNotFound:false});},[updateChatgptRecord]);
  const refreshChatgptJob=useCallback(async requestId=>{
    const record=chatgptRecords.current.get(requestId);if(!record||record.busy)return;
    updateChatgptRecord(requestId,{busy:'checking'});
    try{acceptChatgptJob(requestId,await chatgptRequest(`/${requestId}`));}
    catch(error){updateChatgptRecord(requestId,{error:error.status===404?'尚未找到原任务。可重新确认原提交；仍使用同一请求，不会重复派发已存在的任务。':`未能刷新任务：${error.message}`,lookupNotFound:error.status===404});}
    finally{updateChatgptRecord(requestId,{busy:null});}
  },[acceptChatgptJob,updateChatgptRecord]);
  const submitChatgptRecord=async requestId=>{
    const record=chatgptRecords.current.get(requestId);if(!record||record.busy||record.job)return;
    updateChatgptRecord(requestId,{busy:'submitting',error:null,lookupNotFound:false});
    let unknown=false;
    try{acceptChatgptJob(requestId,await chatgptRequest('',{method:'POST',body:JSON.stringify(record.body)}));}
    catch(error){unknown=true;updateChatgptRecord(requestId,{error:`未能确认提交：${error.message}。正在查询原请求，不会自动重新发送。`});}
    finally{updateChatgptRecord(requestId,{busy:null});}
    if(unknown&&chatgptMounted.current)void refreshChatgptJob(requestId);
  };
  const submitChatgpt=(snapshot,question)=>{
    const requestId=crypto.randomUUID();
    const body=Object.freeze({requestId,documentId:snapshot.documentId,page:snapshot.page,question,selection:Object.freeze(snapshot.kind==='region'?{kind:'region',text:'',preview:snapshot.preview}:{kind:'text',text:snapshot.text})});
    chatgptRecords.current.set(requestId,{requestId,title:snapshot.title,body,job:null,error:null,busy:null});setChatgptJobs([...chatgptRecords.current.values()]);setHandoffRequestId(requestId);void submitChatgptRecord(requestId);
  };
  const resumeChatgptJob=async requestId=>{
    const record=chatgptRecords.current.get(requestId);if(!record||record.busy||record.job?.state!=='needs_user'||!record.job.canResume)return;
    updateChatgptRecord(requestId,{busy:'resuming',error:null});
    try{acceptChatgptJob(requestId,await chatgptRequest(`/${requestId}/resume`,{method:'POST',body:'{}'}));}
    catch(error){updateChatgptRecord(requestId,{error:`未能确认继续连接：${error.message}。请刷新原任务状态，不要重新发送。`});}
    finally{updateChatgptRecord(requestId,{busy:null});}
  };
  useEffect(()=>{
    chatgptMounted.current=true;
    const timer=setInterval(()=>{for(const record of chatgptRecords.current.values())if(!record.busy&&!record.lookupNotFound&&(!record.job||CHATGPT_RUNNING.has(record.job.state)))void refreshChatgptJob(record.requestId);},1500);
    return()=>{chatgptMounted.current=false;clearInterval(timer);};
  },[refreshChatgptJob]);
  const [handoffCopying,setHandoffCopying]=useState(false);
  const handoffCopyPending=useRef(false);
  const handoffOpen=Boolean(handoff&&handoff.documentId===current?.id&&handoff.page===page);
  const handoffTrigger=useRef(null);
  const [loading,setLoading]=useState(true),[opening,setOpening]=useState(false),[importing,setImporting]=useState(false),[toast,setToast]=useState(null),[dragging,setDragging]=useState(false),[exporting,setExporting]=useState(false);
  const currentIdRef=useRef(current?.id);currentIdRef.current=current?.id;
  const currentPageRef=useRef(page);currentPageRef.current=page;
  const input=useRef(null),notesRef=useRef(null),openToken=useRef(0),toastTimer=useRef(null),searchSequence=useRef(0);
  const notify=useCallback((message,type='error')=>{setToast({message,type});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),type==='error'?11000:5000);},[]);
  const refresh=async()=>{const data=await api('/documents');setDocuments(data.documents);return data.documents;};
  const openDocument=async(id,targetPage)=>{
    const token=++openToken.current;setOpening(true);setSelection(null);setModal(false);setHandoff(null);setAnswersOpen(false);setFind('');setFocused(null);
    try {await notesRef.current?.flush();if(token!==openToken.current)return false;const data=await api(`/documents/${encodeURIComponent(id)}`);if(token!==openToken.current)return false;const requested=targetPage??data.document.lastPage??1;const valid=Number.isSafeInteger(requested)&&requested>=1&&requested<=data.document.pageCount;setCurrent(data.document);setAnnotations(data.annotations);setPage(valid?requested:1);if(!valid)notify('链接中的页码无效，已打开第 1 页。');try{localStorage.setItem('paperdesk-current',id);}catch{}return true;}
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
  const savedDoc=useCallback((doc,expectedRevision)=>{if(!doc)return;const apply=d=>d?.id===doc.id&&(expectedRevision===undefined||d.notesRevision===expectedRevision||d.notesRevision===doc.notesRevision)?{...d,...doc}:d;setDocuments(ds=>ds.map(apply));setCurrent(apply);},[]);
  const notesDirtyChanged=useCallback((documentId,dirty)=>{if(currentIdRef.current===documentId)setNotesState(value=>value.documentId===documentId&&value.dirty===dirty?value:{documentId,dirty});},[]);
  const codex=useCodexContext({document:current,page,selection,notesDirty:notesState.documentId===current?.id&&notesState.dirty,onDocument:savedDoc,onError:notify});
  const changePage=n=>{if(!Number.isSafeInteger(n)||n<1||n>(current?.pageCount||0))return;setHandoff(null);setPage(n);setSelection(null);setFind('');setFocused(null);};
  useEffect(()=>{setHandoff(null);},[current?.id,page]);
  const openHandoff=()=>{try{setHandoff(createChatgptHandoffSnapshot(current,page,selection));setHandoffRequestId(null);}catch(error){notify(error.message);}};
  const viewChatgptAnswers=()=>{setHandoff(null);setAnswersOpen(true);};
  const currentChatgptJobs=chatgptJobs.filter(record=>record.body.documentId===current?.id).slice().reverse();
  const closeHandoff=()=>{const documentId=current?.id,closedPage=page;setHandoff(null);requestAnimationFrame(()=>{if(currentIdRef.current===documentId&&currentPageRef.current===closedPage)handoffTrigger.current?.focus();});};
  // Clipboard writes cannot be cancelled. Keep one lock across dialog mounts
  // so an old document's delayed write cannot finish after a newer copy.
  const copyHandoffPrompt=async prompt=>{
    if(handoffCopyPending.current)throw new Error('Clipboard write pending');
    handoffCopyPending.current=true;setHandoffCopying(true);
    try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(prompt);}
    finally{handoffCopyPending.current=false;setHandoffCopying(false);}
  };
  const toggleToc=open=>{setTocOpen(open);setSelection(null);if(open&&window.matchMedia('(max-width:780px)').matches)setShowNotes(false);};
  const toggleNotes=()=>{if(!showNotes&&window.matchMedia('(max-width:780px)').matches)setTocOpen(false);setShowNotes(!showNotes);};
  const revealNotes=()=>{if(window.matchMedia('(max-width:780px)').matches)setTocOpen(false);setShowNotes(true);};
  useEffect(()=>{
    const media=window.matchMedia('(max-width:780px)');
    const fitPanels=()=>{if(media.matches&&tocOpen)setShowNotes(false);};
    fitPanels();media.addEventListener('change',fitPanels);
    return()=>media.removeEventListener('change',fitPanels);
  },[tocOpen]);
  useEffect(()=>{if(current)patchDocument(current.id,{lastPage:page}).catch(e=>notify(`阅读位置未保存：${e.message}`));},[current?.id,page]);
  const importFiles=async files=>{
    if(importing)return;
    if(handoffOpen||answersOpen){notify('请先关闭 ChatGPT 窗口，再导入 PDF。');return;}
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
  const createAnnotation=async()=>{
    if(!selection||!current||selection.documentId!==current.id)return;
    if(selection.rects.length>200){notify('选中的内容过长，请分段添加高亮。');return;}
    setAnnotationBusy(true);
    try{const {documentId,preview,...body}=selection;const data=await api(`/documents/${documentId}/annotations`,{method:'POST',body:JSON.stringify({...body,comment,color})});if(currentIdRef.current!==documentId){notify('批注已保存到原文献。','success');return;}setAnnotations(as=>[...as,data.annotation]);setModal(false);setSelection(null);setComment('');setTab('annotations');revealNotes();setFocused(data.annotation.id);window.getSelection()?.removeAllRanges();notify(selection.kind==='region'?'区域批注已保存。':'高亮与批注已保存。','success');}
    catch(err){notify(err.message);}finally{setAnnotationBusy(false);}
  };
  const updateAnnotation=async(id,body)=>{try{const data=await api(`/documents/${current.id}/annotations/${id}`,{method:'PATCH',body:JSON.stringify(body)});setAnnotations(as=>as.map(a=>a.id===id?data.annotation:a));return true;}catch(err){notify(err.message);return false;}};
  const deleteAnnotation=async id=>{try{await api(`/documents/${current.id}/annotations/${id}`,{method:'DELETE'});setAnnotations(as=>as.filter(a=>a.id!==id));notify('批注已删除。','success');}catch(err){notify(err.message);}};
  const exportMarkdown=async()=>{
    if(!current)return;setExporting(true);
    try{await notesRef.current?.flush();const response=await fetch(`/api/documents/${current.id}/export`);if(!response.ok){const e=await response.json();throw new Error(e.error||'导出失败');}const blob=await response.blob();const url=URL.createObjectURL(blob),a=window.document.createElement('a');a.href=url;a.download=`${current.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'paper-notes'}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);notify('Markdown 已导出，包含笔记与全部批注。','success');}catch(err){notify(`导出未完成：${err.message}`);}finally{setExporting(false);}
  };
  return <div className="app-shell" onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();if(!handoffOpen)setDragging(true);}}} onDrop={e=>{e.preventDefault();setDragging(false);importFiles(e.dataTransfer.files);}}>
    <input ref={input} className="hidden-input" type="file" accept=".pdf,application/pdf" multiple aria-label="选择 PDF 文件" onChange={e=>importFiles(e.target.files)}/>
    <aside id="library-panel" className={`sidebar ${showLibrary?'':'collapsed'}`} aria-label="文献栏" inert={modal||handoffOpen||!showLibrary||undefined}>
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
    <main className="main-workspace" inert={modal||handoffOpen||answersOpen||undefined}>
      <header className="workspace-header"><button className="icon-button library-toggle" aria-label={showLibrary?'收起文献栏':'展开文献栏'} title={showLibrary?'收起文献栏':'展开文献栏'} aria-expanded={showLibrary} aria-controls="library-panel" onClick={toggleLibrary}>{showLibrary?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}</button><div className="header-title"><span className="eyebrow">YOUR READING SPACE</span><h1 title={current?.title}>{current?current.title:'把论文读成自己的理解。'}</h1></div><div className="header-actions">{currentChatgptJobs.length>0&&<button className="secondary-button" onClick={viewChatgptAnswers}>查看回答</button>}{current&&!codex.dismissed&&<div className="codex-status" data-shared={codex.shared} role="status"><span>{codex.status==='shared'?'选区已共享':codex.status==='error'?'阅读上下文暂不可用':codex.status==='ready'?'阅读上下文已就绪':'正在准备阅读上下文…'}</span><button className="icon-button small" aria-label={codex.shared?'停止共享选区':'关闭 Codex 状态'} onClick={codex.shared?codex.clear:codex.dismiss}><X size={13}/></button></div>}{current&&<><button className="secondary-button export-button" aria-label="导出 Markdown" title="导出 Markdown" disabled={exporting} onClick={exportMarkdown}>{exporting?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>}<span>导出 Markdown</span></button><button className="icon-button panel-toggle" aria-label={showNotes?'收起笔记面板':'展开笔记面板'} onClick={toggleNotes}>{showNotes?<PanelRightClose size={19}/>:<PanelRightOpen size={19}/>}</button></>}<span className="local-pill">LOCAL</span></div></header>
      {current?<div className={`reading-layout ${showNotes?'':'notes-hidden'}`}>
        <Reader document={current} page={page} onPage={changePage} annotations={annotations} selection={selection} onSelection={setSelection} selectionLocked={modal||handoffOpen||answersOpen} find={find} focusedAnnotation={focused} focusTick={focusTick} tocOpen={tocOpen} onToggleToc={toggleToc}/>
        <aside className={`notes-panel ${showNotes?'':'collapsed'}`} aria-label="笔记与批注" inert={opening||undefined}><div className="panel-tabs"><button className={tab==='notes'?'selected':''} onClick={()=>setTab('notes')}><Pencil size={14}/> 笔记</button><button className={tab==='annotations'?'selected':''} onClick={()=>setTab('annotations')}><MessageSquare size={14}/> 批注 <span>{annotations.length}</span></button></div>
          <div className={tab==='notes'?'panel-content':'panel-content invisible'}><Notes key={current.id} ref={notesRef} document={current} onSaved={savedDoc} onError={notify} onDirtyChange={notesDirtyChanged}/></div>
          {tab==='annotations'&&<div className="annotations-body"><div className="section-eyebrow">MARGINALIA</div><h2>与原文的对话</h2><p className="notes-intro">选中文字可高亮；扫描页、公式和图表可用“区域批注”框选。点击批注可回到标记处。</p>{annotations.length?annotations.slice().sort((a,b)=>a.page-b.page||a.createdAt.localeCompare(b.createdAt)).map(a=><AnnotationCard key={a.id} annotation={a} onJump={a=>{setSelection(null);setPage(a.page);setFocused(a.id);setFocusTick(t=>t+1);setFind('');if(window.matchMedia('(max-width:780px)').matches){setShowNotes(false);setTocOpen(false);}}} onUpdate={updateAnnotation} onDelete={deleteAnnotation}/>):<div className="empty-annotations"><Highlighter size={28} strokeWidth={1.25}/><p>给值得回看的地方，留下想法。</p><span>选中文字或框选区域 → 写下评论</span></div>}</div>}
        </aside>
        {opening&&<div className="opening-mask" role="status"><LoaderCircle className="spin"/> 正在打开文献…</div>}
      </div>:<section className="welcome"><div className="welcome-kicker"><span/> A QUIET PLACE FOR BIG IDEAS</div><h2>读过的每一页，<br/>都可以<span>有所留下。</span></h2><p>把文献、原文批注和阅读笔记放在一起。<br/>从一篇论文开始，慢慢建立自己的理解。</p><div className="welcome-actions"><button className="primary-button" disabled={importing} onClick={()=>input.current.click()}><Upload size={17}/> 导入第一篇 PDF <ArrowRight size={17}/></button><button className="text-button" disabled={importing} onClick={demo}>先用示例体验 <ArrowUpRight size={15}/></button></div><div className="desk-illustration" aria-hidden="true"><div className="book-back"/><div className="paper-card"><span>PAPER / 001</span><h3>The art of<br/>paying attention.</h3><div className="fake-line long"/><div className="fake-line"/><div className="fake-line highlighted"/><div className="fake-line short"/><div className="paper-stamp">read.<br/>think.<br/>keep.</div></div><div className="margin-note">有些句子，<br/>值得多停留一会儿。<span>↖</span></div></div><div className="welcome-features"><span><Search size={15}/> 全文检索</span><span><Highlighter size={15}/> 原文高亮</span><span><Pencil size={15}/> 笔记</span><span><LockKeyhole size={15}/> 完全本地</span></div></section>}
    </main>
    {selection&&!modal&&!handoffOpen&&!answersOpen&&!opening&&<div className="selection-bar" aria-label="选区操作" onPointerDown={e=>e.preventDefault()}>{selection.kind==='region'?<ScanLine size={17}/>:<Highlighter size={17}/>}<div className="selection-summary">{selection.kind==='region'?<><span>区域批注 · 第 {selection.page} 页</span><p>已框选页面区域，添加一条想法。</p></>:<><span>已选中 {selection.quote.length} 个字符 · 核对引文</span><p title={selection.quote}>{selection.quote}</p></>}</div><button className="text-button codex-share" onClick={codex.share}>交给 Codex</button><button ref={handoffTrigger} className="text-button chatgpt-share" onClick={openHandoff}>交给 ChatGPT</button><button className="mini-primary" onClick={()=>{setComment('');setColor('yellow');setModal(true);}}>{selection.kind==='region'?'添加区域批注':'高亮并批注'}</button><button className="icon-button small" aria-label="取消选择" onClick={()=>{setSelection(null);window.getSelection()?.removeAllRanges();}}><X size={16}/></button></div>}
    {handoffOpen&&<ChatgptHandoff snapshot={handoff} onClose={closeHandoff} copying={handoffCopying} onCopyPrompt={copyHandoffPrompt} onSubmit={submitChatgpt} submission={chatgptJobs.find(record=>record.requestId===handoffRequestId)} onViewAnswers={viewChatgptAnswers}/>}{answersOpen&&<ChatgptAnswers records={currentChatgptJobs} onClose={()=>setAnswersOpen(false)} onResume={resumeChatgptJob} onRefresh={refreshChatgptJob} onRetry={submitChatgptRecord}/>}
    {modal&&selection&&<div className="modal-backdrop" onKeyDown={e=>{if(e.key==='Escape'&&!annotationBusy)setModal(false);if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll('button:not(:disabled),textarea')];const first=items[0],last=items.at(-1);if(e.shiftKey&&window.document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&window.document.activeElement===last){e.preventDefault();first?.focus();}}}}><section className="annotation-modal" role="dialog" aria-modal="true" aria-labelledby="annotation-title"><div className="modal-heading"><div><span className="section-eyebrow">LEAVE A THOUGHT</span><h2 id="annotation-title">{selection.kind==='region'?'区域批注':'高亮与批注'} <small>第 {selection.page} 页</small></h2></div><button className="icon-button" disabled={annotationBusy} aria-label="关闭批注窗口" onClick={()=>setModal(false)}><X size={20}/></button></div>{selection.kind==='region'?<figure className="region-preview">{selection.preview&&<img src={selection.preview} alt={`第 ${selection.page} 页框选区域预览`}/>}<figcaption>批注绑定这块区域；原始 PDF 保持不变。</figcaption></figure>:<blockquote>{selection.quote}</blockquote>}<label className="comment-label" htmlFor="new-comment">你的想法 <span>可选</span></label><textarea autoFocus id="new-comment" aria-label="批注评论" placeholder={selection.kind==='region'?'记录这段内容、公式或图表的疑问与理解。':'为什么这句话值得留下？'} maxLength={20000} value={comment} onChange={e=>setComment(e.target.value)}/><div className="modal-footer"><div className="color-picker" aria-label="高亮颜色">{[['yellow','黄色'],['green','绿色'],['pink','粉色']].map(([v,label])=><button key={v} aria-label={label} aria-pressed={color===v} className={`color-choice ${v}`} onClick={()=>setColor(v)}>{color===v&&<Check size={15}/>}</button>)}</div><button className="primary-button" disabled={annotationBusy} onClick={createAnnotation}>{annotationBusy?<LoaderCircle className="spin" size={16}/>:selection.kind==='region'?<ScanLine size={16}/>:<Highlighter size={16}/>} 保存批注</button></div></section></div>}
    {toast&&<div className={`toast ${toast.type}`} role={toast.type==='error'?'alert':'status'} inert={handoffOpen||undefined}>{toast.type==='success'&&<Check size={16}/>}<span>{toast.message}</span><button aria-label="关闭提示" onClick={()=>setToast(null)}><X size={16}/></button></div>}
    {dragging&&<div className="drop-overlay" onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();e.stopPropagation();setDragging(false);importFiles(e.dataTransfer.files);}}><Upload size={42}/><h2>把 PDF 放到书桌上</h2><p>支持多文件，全部保存在本机</p></div>}
  </div>;
}
