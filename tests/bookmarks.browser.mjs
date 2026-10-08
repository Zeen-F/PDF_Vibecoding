import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { readerLayoutPdf } from './fixtures/reader-layout.mjs';

export async function bookmarkWorkflow({context,root,onPreview,modes=['library','vault']}) {
  for(const mode of modes)await runBookmarkMode({context,root,onPreview,mode});
}

async function runBookmarkMode({context,root,onPreview,mode}) {
  const fixture=await mkdtemp(path.join(tmpdir(),`paperdesk-bookmarks-${mode}-`));
  const vaultDir=path.join(fixture,'书签知识库'),dataDir=path.join(fixture,'cache');
  const firstBytes=readerLayoutPdf({pageCount:8,variant:`bookmark-${mode}-first`}),secondBytes=readerLayoutPdf({pageCount:6,variant:`bookmark-${mode}-second`});
  if(mode==='vault'){
    await mkdir(path.join(vaultDir,'.obsidian'),{recursive:true});await mkdir(path.join(vaultDir,'研究'),{recursive:true});
    await writeFile(path.join(vaultDir,'研究','甲.pdf'),firstBytes);await writeFile(path.join(vaultDir,'研究','乙.pdf'),secondBytes);
  }
  let runtime=createApp(mode==='vault'?{vaultDir,dataDir}:{dataDir}),server,base;
  const start=async()=>{await runtime.ready;server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;};
  const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();};
  await start();
  const request=async(route,method='GET',body)=>{
    const response=await fetch(`${base}/api${route}`,{method,headers:body instanceof FormData?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const data=await response.json();assert.ok(response.ok,`${method} ${route}: ${JSON.stringify(data)}`);return {response,data};
  };
  const prepare=async(name,bytes)=>{
    if(mode==='vault')return(await request('/vault/pdfs/open','POST',{path:`研究/${name}.pdf`})).data.document;
    const body=new FormData();body.append('file',new Blob([bytes],{type:'application/pdf'}),`${name}.pdf`);return(await request('/documents','POST',body)).data.document;
  };
  const first=await prepare('甲',firstBytes),second=await prepare('乙',secondBytes);
  await request(`/documents/${first.id}`,'PATCH',{notesZh:'删除个人书签后，阅读笔记仍须保留。',expectedNotesRevision:first.notesRevision});
  const annotation=(await request(`/documents/${first.id}/annotations`,'POST',{kind:'text',page:6,quote:'原文引文',comment:'删除书签后仍保留的批注',color:'yellow',rects:[{x:.1,y:.1,width:.2,height:.02}],requestId:randomUUID()})).data.annotation;
  const page=await context.newPage(),errors=[],writes=[],uploads=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',req=>{if(req.method()==='POST'&&req.url()===`${base}/api/documents`)uploads.push(req.url());if(['POST','PATCH','DELETE'].includes(req.method())&&req.url().includes('/bookmarks'))writes.push({method:req.method(),url:req.url(),body:req.postDataJSON()});});
  await page.addInitScript(()=>{window.paperdeskDesktop={onFlushRequest(callback){window.__bookmarkFlush=callback;return()=>{};},onLibrarySwitch(){return()=>{};}};});
  const books=()=>page.getByRole('region',{name:'个人书签',exact:true});
  const bookRow=at=>page.locator(`.bookmark-row[data-bookmark-page="${at}"]`);
  const jump=at=>bookRow(at).getByRole('button',{name:new RegExp(`^书签：.*，PDF 第 ${at} 页$`)});
  const rename=at=>bookRow(at).getByRole('button',{name:new RegExp(`^重命名书签：.*，PDF 第 ${at} 页$`)});
  const remove=at=>bookRow(at).getByRole('button',{name:new RegExp(`^删除书签：.*，PDF 第 ${at} 页$`)});
  const editor=at=>page.getByRole('textbox',{name:`书签名称，PDF 第 ${at} 页`,exact:true});
  const documentButton=id=>page.locator(`[data-document-id="${id}"] .document-item`);
  const currentPage=()=>page.getByRole('spinbutton',{name:'页码',exact:true});
  const capture=async label=>{if(!onPreview)return;const at=await currentPage().inputValue();await expect(page.locator('.reader-status')).toHaveCount(0);await expect(page.getByLabel(`PDF 第 ${at} 页`,{exact:true})).not.toHaveClass(/is-loading/);await onPreview(page,label);};
  const openBooks=async()=>{if(!await books().isVisible()){const loaded=page.waitForResponse(response=>response.url().startsWith(`${base}/api/documents/`)&&response.url().endsWith('/bookmarks')&&response.request().method()==='GET');loaded.catch(()=>{});await page.getByRole('button',{name:'展开书签',exact:true}).click();await loaded;}await expect(books()).toBeVisible();await expect(page.getByRole('button',{name:'刷新书签',exact:true})).toBeEnabled();};
  const goto=async at=>{if(await books().isVisible())await page.getByRole('button',{name:'关闭书签',exact:true}).click();await currentPage().fill(String(at));await currentPage().press('Enter');await expect(currentPage()).toHaveValue(String(at));await expect(page.getByLabel(`PDF 第 ${at} 页`,{exact:true})).toBeVisible();};
  const waitGate=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Fixture gate not entered: ${label}`)),15000);})]);}finally{clearTimeout(timer);}};
  let releaseWrite,releaseRead;
  try{
    await page.goto(base);await page.waitForLoadState('networkidle');await documentButton(first.id).click();
    await expect(page.getByRole('textbox',{name:'笔记',exact:true})).toHaveValue('删除个人书签后，阅读笔记仍须保留。');
    const contents=page.getByRole('complementary',{name:'目录面板',exact:true});
    for(const id of [first.id,second.id,first.id]){
      await documentButton(id).click();
      for(let repeat=0;repeat<2;repeat++){
        await page.getByRole('button',{name:'展开目录',exact:true}).click();await expect(contents).toHaveCount(1);await expect(contents).toBeVisible();
        await contents.getByRole('button',{name:'关闭目录',exact:true}).click();await expect(contents).toHaveCount(0);
      }
    }
    await goto(2);await openBooks();
    let entered;const captured=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{releaseWrite=resolve;});
    await page.route(`${base}/api/documents/${first.id}/bookmarks`,async route=>{if(route.request().method()==='POST'){entered();await held;}await route.continue();});
    const added=page.waitForResponse(response=>response.url()===`${base}/api/documents/${first.id}/bookmarks`&&response.request().method()==='POST',{timeout:60000});added.catch(()=>{});
    await expect(page.getByRole('button',{name:'添加当前页书签',exact:true})).toBeEnabled();const holdStarted=Date.now();await page.getByRole('button',{name:'添加当前页书签',exact:true}).evaluate(element=>{element.click();element.click();});await waitGate(captured,'bookmark POST');
    await expect(currentPage()).toBeDisabled();await expect(documentButton(second.id)).toBeDisabled();
    const flushDuringWrite=await page.evaluate(async()=>{try{await window.__bookmarkFlush();return '';}catch(error){return error.message;}});assert.match(flushDuringWrite,/书签正在保存/);
    assert.equal(writes.filter(item=>item.method==='POST').length,1,'Double click must submit only once');
    const holdDuration=Date.now()-holdStarted;releaseWrite();releaseWrite=null;const addedResponse=await added;assert.equal(addedResponse.status(),201);const pageTwo=(await addedResponse.json()).bookmark;
    await expect(jump(2)).toHaveAccessibleName('书签：第 2 页，PDF 第 2 页');await expect(page.getByRole('button',{name:'添加当前页书签',exact:true})).toBeDisabled();
    await page.unroute(`${base}/api/documents/${first.id}/bookmarks`);
    console.log(`PASS: ${mode} double-click/current-page/document/native-flush write guards (POST held ${holdDuration} ms)`);
    const dedup=await request(`/documents/${first.id}/bookmarks`,'POST',{page:2,title:'不应覆盖已有名字'});assert.equal(dedup.response.status,200);assert.equal(dedup.data.bookmark.id,pageTwo.id);assert.equal(dedup.data.bookmark.title,'第 2 页');
    await goto(4);await openBooks();await page.getByRole('button',{name:'添加当前页书签',exact:true}).click();await expect(jump(4)).toBeVisible();
    for(const at of [2,4]){await rename(at).click();await editor(at).fill('回看条件');await page.getByRole('button',{name:'保存书签名称',exact:true}).click();await expect(jump(at)).toHaveAccessibleName(`书签：回看条件，PDF 第 ${at} 页`);}
    await page.evaluate(id=>localStorage.setItem(`paperdesk-toc-offset-${id}`,'3'),first.id);
    await goto(1);await openBooks();await jump(2).click();await expect(currentPage()).toHaveValue('2');
    await page.getByRole('combobox',{name:'页面布局',exact:true}).selectOption('4');await openBooks();await jump(4).click();await expect(currentPage()).toHaveValue('4');await expect(page.getByLabel('PDF 第 4 页',{exact:true})).toBeVisible();
    await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('continuous');await page.getByRole('combobox',{name:'页面布局',exact:true}).selectOption('2');await openBooks();await jump(2).click();await expect(currentPage()).toHaveValue('2');
    await page.setViewportSize({width:640,height:720});await openBooks();await capture(`${mode}-bookmarks-narrow`);await jump(4).click();await expect(currentPage()).toHaveValue('4');await expect(books()).not.toBeVisible();
    await page.setViewportSize({width:1440,height:1000});await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('paged');await page.getByRole('combobox',{name:'页面布局',exact:true}).selectOption('1');await goto(2);await openBooks();
    await capture(`${mode}-bookmarks-wide`);
    await page.route(`${base}/api/documents/${first.id}/bookmarks/${pageTwo.id}`,async route=>{if(route.request().method()==='PATCH')await route.fulfill({status:500,json:{error:'隔离验证：保存失败'}});else await route.continue();});
    await rename(2).click();await editor(2).fill('保存失败仍保留的名称');await page.getByRole('button',{name:'保存书签名称',exact:true}).click();
    await expect(page.locator('.bookmarks-error')).toContainText('输入仍保留');await expect(editor(2)).toHaveValue('保存失败仍保留的名称');
    await page.getByRole('button',{name:'关闭书签',exact:true}).click();await expect(books()).not.toBeVisible();
    await page.getByRole('button',{name:'展开目录',exact:true}).click();await expect(contents).toHaveCount(1);
    await contents.getByRole('button',{name:'关闭目录',exact:true}).click();await expect(contents).toHaveCount(0);
    await openBooks();await expect(editor(2)).toHaveValue('保存失败仍保留的名称');
    await page.getByRole('button',{name:'关闭书签',exact:true}).click();
    if(await page.getByRole('button',{name:'展开笔记面板',exact:true}).count())await page.getByRole('button',{name:'展开笔记面板',exact:true}).click();
    await page.locator('.panel-tabs button').last().click();await page.locator('.annotation-card .page-link').click();await expect(currentPage()).toHaveValue('2');await expect(page.locator('.toast')).toContainText('未保存或未确认的书签更改');
    await documentButton(second.id).click();await expect(page.locator('.toast')).toContainText('未保存或未确认的书签更改');await expect(documentButton(first.id)).toHaveClass(/active/);
    const uploadsBefore=uploads.length;await page.getByLabel('选择 PDF 文件').setInputFiles({name:'另文献.pdf',mimeType:'application/pdf',buffer:secondBytes});await expect(page.locator('.toast')).toContainText('导入未开始');assert.equal(uploads.length,uploadsBefore);
    const flushDraft=await page.evaluate(async()=>{try{await window.__bookmarkFlush();return '';}catch(error){return error.message;}});assert.match(flushDraft,/未保存或未确认的书签/);
    await openBooks();await expect(editor(2)).toHaveValue('保存失败仍保留的名称');await expect(currentPage()).toBeDisabled();
    await page.getByRole('button',{name:'取消重命名',exact:true}).click();await expect(editor(2)).toHaveCount(0);await page.unroute(`${base}/api/documents/${first.id}/bookmarks/${pageTwo.id}`);
    await rename(2).click();await editor(2).fill('本窗口保留的名称草稿');
    const beforeConflict=(await request(`/documents/${first.id}/bookmarks`)).data.bookmarks.find(item=>item.id===pageTwo.id);
    await request(`/documents/${first.id}/bookmarks/${pageTwo.id}`,'PATCH',{title:'另一个窗口保存的名称',expectedUpdatedAt:beforeConflict.updatedAt});
    await page.getByRole('button',{name:'保存书签名称',exact:true}).click();await expect(page.locator('.bookmarks-error')).toContainText('其他窗口修改');await expect(editor(2)).toHaveValue('本窗口保留的名称草稿');await expect(page.getByRole('button',{name:'保存书签名称',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'读取最新书签',exact:true}).click();await expect(page.locator('.bookmark-editor')).toContainText('另一个窗口保存的名称');await expect(editor(2)).toHaveValue('本窗口保留的名称草稿');
    await page.getByRole('button',{name:'保存书签名称',exact:true}).click();await expect(jump(2)).toHaveAccessibleName('书签：本窗口保留的名称草稿，PDF 第 2 页');
    const stale=(await request(`/documents/${first.id}/bookmarks`)).data;
    let enteredRead,holdOnce=true;const capturedRead=new Promise(resolve=>{enteredRead=resolve;});const heldRead=new Promise(resolve=>{releaseRead=resolve;});
    await page.route(`${base}/api/documents/${first.id}/bookmarks`,async route=>{if(route.request().method()==='GET'&&holdOnce){holdOnce=false;enteredRead();await heldRead;try{await route.fulfill({status:200,json:stale});}catch{}}else await route.continue();});
    await page.getByRole('button',{name:'刷新书签',exact:true}).click();await waitGate(capturedRead,'stale bookmark GET');
    await remove(4).click();await expect(bookRow(4)).toHaveCount(0);releaseRead();releaseRead=null;
    await expect(bookRow(4)).toHaveCount(0);await expect(jump(2)).toBeVisible();await page.unroute(`${base}/api/documents/${first.id}/bookmarks`);
    await goto(3);await openBooks();
    let lostPost=true;await page.route(`${base}/api/documents/${first.id}/bookmarks`,async route=>{if(route.request().method()==='POST'&&lostPost){lostPost=false;await route.fetch();await route.fulfill({status:500,json:{error:'隔离验证：添加响应丢失'}});}else await route.continue();});
    const postsBefore=writes.filter(item=>item.method==='POST').length;await page.getByRole('button',{name:'添加当前页书签',exact:true}).click();await expect(page.getByRole('button',{name:'重试添加书签',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'重试添加书签',exact:true}).click();await expect(jump(3)).toBeVisible();assert.equal(writes.filter(item=>item.method==='POST').length,postsBefore+1,'Readback confirms a lost POST without another write');await page.unroute(`${base}/api/documents/${first.id}/bookmarks`);
    const pageThree=(await request(`/documents/${first.id}/bookmarks`)).data.bookmarks.find(item=>item.page===3);
    let lostDelete=true;await page.route(`${base}/api/documents/${first.id}/bookmarks/${pageThree.id}`,async route=>{if(route.request().method()==='DELETE'&&lostDelete){lostDelete=false;await route.fetch();await route.fulfill({status:500,json:{error:'隔离验证：删除响应丢失'}});}else await route.continue();});
    const deletesBefore=writes.filter(item=>item.method==='DELETE').length;await remove(3).click();await expect(page.getByRole('button',{name:'重试删除书签',exact:true})).toBeVisible();await expect(bookRow(3)).toHaveCount(1);
    await page.getByRole('button',{name:'重试删除书签',exact:true}).click();await expect(bookRow(3)).toHaveCount(0);assert.equal(writes.filter(item=>item.method==='DELETE').length,deletesBefore+1);await page.unroute(`${base}/api/documents/${first.id}/bookmarks/${pageThree.id}`);
    await page.getByRole('button',{name:'添加当前页书签',exact:true}).click();await expect(jump(3)).toBeVisible();
    const staleBeforeSwitch=(await request(`/documents/${first.id}/bookmarks`)).data;
    let switchRead;const switchCaptured=new Promise(resolve=>{switchRead=resolve;});const switchHeld=new Promise(resolve=>{releaseRead=resolve;});
    await page.route(`${base}/api/documents/${first.id}/bookmarks`,async route=>{if(route.request().method()==='GET'){switchRead();await switchHeld;try{await route.fulfill({status:200,json:staleBeforeSwitch});}catch{}}else await route.continue();});
    await page.getByRole('button',{name:'刷新书签',exact:true}).click();await waitGate(switchCaptured,'switch bookmark GET');await documentButton(second.id).click();
    await expect(documentButton(second.id)).toHaveClass(/active/);releaseRead();releaseRead=null;await expect(page.locator('.bookmark-row')).toHaveCount(0);await page.unroute(`${base}/api/documents/${first.id}/bookmarks`);
    await expect(currentPage()).toHaveValue('1');await openBooks();await page.getByRole('button',{name:'添加当前页书签',exact:true}).click();await expect(jump(1)).toHaveAccessibleName('书签：第 1 页，PDF 第 1 页');
    await page.reload();await expect(documentButton(second.id)).toHaveClass(/active/);await openBooks();await expect(jump(1)).toBeVisible();await expect(bookRow(2)).toHaveCount(0);
    await documentButton(first.id).click();await openBooks();await expect(jump(2)).toBeVisible();await expect(jump(3)).toBeVisible();await expect(bookRow(1)).toHaveCount(0);await remove(2).click();await expect(bookRow(2)).toHaveCount(0);
    const preserved=(await request(`/documents/${first.id}`)).data;assert.equal(preserved.document.notesZh,'删除个人书签后，阅读笔记仍须保留。');assert.ok(preserved.annotations.some(item=>item.id===annotation.id));
    const pdfResponse=await fetch(`${base}/api/documents/${first.id}/file`);assert.equal(createHash('sha256').update(Buffer.from(await pdfResponse.arrayBuffer())).digest('hex'),createHash('sha256').update(firstBytes).digest('hex'));
    if(mode==='vault'){const markdown=await readFile(path.join(vaultDir,'Paperdesk','Notes',`${first.id}.md`),'utf8');assert.ok(markdown.includes('删除个人书签后，阅读笔记仍须保留。'));assert.ok(markdown.includes('删除书签后仍保留的批注'));}
    await stop();runtime=createApp(mode==='vault'?{vaultDir,dataDir:path.join(fixture,'rebuilt-cache')}:{dataDir});await start();await page.goto(base);await documentButton(first.id).click();await openBooks();await expect(jump(3)).toBeVisible();await expect(bookRow(2)).toHaveCount(0);
    await jump(3).click();await expect(currentPage()).toHaveValue('3');assert.deepEqual(errors,[]);
    console.log(`PASS: ${mode} personal bookmarks add/dedup/rename/jump/layout/narrow, unique directory lifecycle/hidden drafts/CAS, stale reads, lost response readback, document isolation, preserved PDF/notes/annotations and restart${mode==='vault'?' from Markdown':''}`);
  }catch(error){await onPreview?.(page,`${mode}-bookmarks-failure`);throw error;}finally{releaseRead?.();releaseWrite?.();await page.close();await stop();await rm(fixture,{recursive:true,force:true});}
}
