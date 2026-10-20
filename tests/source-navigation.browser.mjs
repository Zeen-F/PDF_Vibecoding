import { openReaderDisplay, closeReaderDisplay } from './reader-display-controls.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { sourceLinkSearch } from '../shared/source-navigation.mjs';

/** Original fixtures and an owned temporary vault only; never a personal library. */
export async function sourceNavigationWorkflow({context,onPreview}) {
  const root=await mkdtemp(join(tmpdir(),'paperdesk-source-browser-')),vaultDir=join(root,'vault');
  let runtime,server,page,release;
  const errors=[];
  try {
    await mkdir(join(vaultDir,'.obsidian'),{recursive:true});
    runtime=createApp({vaultDir,dataDir:join(root,'cache')});await runtime.ready;
    server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}`;
    const post=async(path,body)=>{
      const response=await fetch(`${base}/api${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.ok(response.ok,await response.clone().text());return response.json();
    };
    const open=async name=>{
      await writeFile(join(vaultDir,`${name}.pdf`),Buffer.concat([bookmarkedPdf(),Buffer.from(`\n% ${name}`)]));
      return(await post('/vault/pdfs/open',{path:`${name}.pdf`})).document;
    };
    const a=await open('来源甲'),b=await open('来源乙');
    const makeCapture=async(document,page,rects)=>{
      const payload={requestId:randomUUID(),documentId:document.id,page,rects,quote:'Synthetic precision source',comment:'Browser source regression'};
      await post('/integrations/knowledge/export',payload);
      return{documentId:document.id,page,pdfSha256:document.pdfSha256,captureId:payload.requestId};
    };
    const first=await makeCapture(a,2,[{x:.1,y:.68,width:.5,height:.2}]);
    const second=await makeCapture(a,3,[{x:.2,y:.25,width:.6,height:.3}]);
    const third=await makeCapture(b,5,[{x:.1,y:.3,width:.4,height:.2}]);
    const {annotation}=await post(`/documents/${a.id}/annotations`,{requestId:randomUUID(),page:4,kind:'region',rects:[{x:.2,y:.3,width:.5,height:.2}],comment:'focused-citation-browser',color:'green'});
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    // Failure-only, bounded viewport metadata from this synthetic fixture.
    // Never collect document text, paths, URLs, request bodies or identifiers.
    await page.addInitScript(()=>{
      const trace={phase:'startup',expected:null,events:[]};let previous='';
      window.sourceViewportTrace=trace;
      window.sampleSourceViewport=kind=>{
        const root=document.querySelector('.pdf-scroll'),input=document.querySelector('input[aria-label="页码"]');
        const number=Number(input?.value),paper=Number.isInteger(number)?root?.querySelector(`.pdf-paper[data-page="${number}"]`):null;
        const bounds=root?.getBoundingClientRect(),rect=paper?.getBoundingClientRect();
        const sample={kind,phase:trace.phase,page:number||null,scrollTop:root?.scrollTop??null,scrollLeft:root?.scrollLeft??null,
          rootHeight:bounds?.height??null,rootWidth:bounds?.width??null,paperHeight:rect?.height??null,paperWidth:rect?.width??null,
          offset:rect?.height?(bounds.top-rect.top)/rect.height:null,
          loading:Boolean(document.querySelector('.reader-status')),opening:Boolean(document.querySelector('.opening-mask')),
          source:Boolean(document.querySelector('.source-return-status')),inputDisabled:input?.disabled??null,fieldFocused:document.activeElement===input};
        const signature=JSON.stringify(sample);if(signature===previous)return;previous=signature;
        trace.events.push({ms:Math.round(performance.now()),...sample});
        if(trace.events.length>64)trace.events.shift();
      };
      for(const event of ['scroll','focusin','focusout','change','popstate'])
        window.addEventListener(event,()=>window.sampleSourceViewport(event),true);
    });
    const phase=(name,expected=null)=>page.evaluate(({name,expected})=>{
      Object.assign(window.sourceViewportTrace,{phase:name,expected});window.sampleSourceViewport('phase');
    },{name,expected});
    const url=target=>`${base}/?${sourceLinkSearch(target)}`;
    const jump=target=>page.evaluate(href=>{history.pushState(null,'',href);dispatchEvent(new PopStateEvent('popstate'));},url(target));
    const marker=target=>page.locator(`[data-source-capture="${target.captureId}"]`);
    const back=page.getByRole('button',{name:'返回上一阅读位置',exact:true}),forward=page.getByRole('button',{name:'前进下一阅读位置',exact:true});
    const expectPage=async number=>{await expect(page.getByRole('spinbutton',{name:'页码',exact:true})).toHaveValue(String(number));await expect(page.getByLabel(`PDF 第 ${number} 页`,{exact:true})).toBeVisible();await expect(page.locator('.opening-mask')).toHaveCount(0);};
    const geometry=async(target,rect)=>{
      await expect(marker(target)).toBeVisible();
      const paper=await page.locator(`.pdf-paper[data-page="${target.page}"]`).boundingBox(),box=await marker(target).boundingBox();
      for(const [actual,expected]of [[box.x,paper.x+paper.width*rect.x],[box.y,paper.y+paper.height*rect.y],[box.width,paper.width*rect.width],[box.height,paper.height*rect.height]])assert.ok(Math.abs(actual-expected)<1.5,`${actual} != ${expected}`);
    };
    await page.goto(url(first));await expectPage(2);
    await openReaderDisplay(page); await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('paged');
    await closeReaderDisplay(page);
    await openReaderDisplay(page); await page.getByRole('combobox',{name:'页面布局',exact:true}).selectOption('1');
    await closeReaderDisplay(page);
    await geometry(first,{x:.1,y:.68,width:.5,height:.2});await expect(back).toBeDisabled();await expect(page.getByRole('button',{name:'返回阅读',exact:true})).toHaveCount(0);
    // Same target repeats should refocus but must not create a second history entry.
    await jump(first);await expectPage(2);await geometry(first,{x:.1,y:.68,width:.5,height:.2});await expect(back).toBeDisabled();
    await page.getByRole('button',{name:'下一页',exact:true}).click();await expectPage(3);await expect(marker(first)).toHaveCount(0);
    await back.click();await expectPage(2);await expect(marker(first)).toBeVisible();
    await forward.click();await expectPage(3);await expect(marker(first)).toHaveCount(0);
    await back.click();await expectPage(2);
    const pageInput=page.getByRole('spinbutton',{name:'页码',exact:true});await pageInput.fill('4');await pageInput.press('Enter');await expectPage(4);await expect(forward).toBeDisabled();
    await page.getByRole('combobox',{name:'阅读缩放',exact:true}).selectOption('1.5');
    await expect(page.locator('.reader-status')).toHaveCount(0);
    const offset=()=>page.evaluate(()=>{const root=document.querySelector('.pdf-scroll'),paper=document.querySelector('.pdf-paper[data-page="'+document.querySelector('input[aria-label="页码"]').value+'"]');const rect=paper.getBoundingClientRect(),bounds=root.getBoundingClientRect();return (bounds.top-rect.top)/rect.height;});
    await page.locator('.pdf-scroll').evaluate(root=>{root.scrollTop=260;root.dispatchEvent(new Event('scroll'));});
    await expect.poll(offset).toBeGreaterThan(.1);
    const previousOffset=await offset();
    await phase('cross-document-blur-and-return',previousOffset);
    // An unchanged page field may lose focus before or during a source jump.
    // Its blur must preserve the current reading offset and history entry.
    await pageInput.press('Tab');
    await expect.poll(async()=>Math.abs(await offset()-previousOffset)).toBeLessThan(.01);
    await pageInput.focus();
    await jump(third);await expectPage(5);await expect(page.locator('.header-title h1')).toHaveText(b.title);
    await onPreview?.(page,'source-return-banner');
    await page.getByRole('button',{name:'返回阅读',exact:true}).click();await expectPage(4);await expect(page.locator('.header-title h1')).toHaveText(a.title);
    await expect.poll(async()=>Math.abs(await offset()-previousOffset)).toBeLessThan(.01);
    await onPreview?.(page,'restored-reading-viewport');
    // A fast source response can replace the document before the next scroll
    // animation frame. Hold frames across that response to exercise the race
    // deterministically, while leaving fetches and React updates running.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const immediateOffset=await page.evaluate(()=>{
      const request=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
      const pending=new Map();let next=1_000_000_000;
      window.requestAnimationFrame=callback=>{const id=next++;pending.set(id,callback);return id;};
      window.cancelAnimationFrame=id=>{if(!pending.delete(id))cancel(id);};
      window.resumeSourceNavigationFrames=()=>{
        window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;
        for(const callback of pending.values())request(callback);
        delete window.resumeSourceNavigationFrames;
      };
      const root=document.querySelector('.pdf-scroll'),paper=document.querySelector('.pdf-paper[data-page="4"]');
      root.scrollTop=360;root.dispatchEvent(new Event('scroll'));
      return (root.getBoundingClientRect().top-paper.getBoundingClientRect().top)/paper.getBoundingClientRect().height;
    });
    await phase('cross-document-before-scroll-frame',immediateOffset);
    try{
      await jump(third);await expect(page.locator('.header-title h1')).toHaveText(b.title);
    }finally{await page.evaluate(()=>window.resumeSourceNavigationFrames?.());}
    await expectPage(5);
    await page.getByRole('button',{name:'返回阅读',exact:true}).click();await expectPage(4);
    await expect.poll(async()=>Math.abs(await offset()-immediateOffset)).toBeLessThan(.01);
    // Re-entering the active, rendered page finishes positioning synchronously,
    // but keeps the continuous-page guard until the next frame. A source jump
    // before that frame must still retain the intervening scroll position.
    await pageInput.focus();
    await page.evaluate(()=>{
      const request=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
      const pending=new Map();let next=1_000_000_000;
      window.requestAnimationFrame=callback=>{const id=next++;pending.set(id,callback);return id;};
      window.cancelAnimationFrame=id=>{if(!pending.delete(id))cancel(id);};
      window.resumeSourceNavigationFrames=()=>{
        window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;
        for(const callback of pending.values())request(callback);
        delete window.resumeSourceNavigationFrames;
      };
    });
    let readyOffset;
    try{
      await pageInput.press('Enter');
      readyOffset=await page.locator('.pdf-scroll').evaluate(root=>{
        const paper=root.querySelector('.pdf-paper[data-page="4"]');
        root.scrollTop=300;root.dispatchEvent(new Event('scroll'));
        return (root.getBoundingClientRect().top-paper.getBoundingClientRect().top)/paper.getBoundingClientRect().height;
      });
      assert.ok(readyOffset>.1);
      await phase('positioned-page-before-guard-frame',readyOffset);
      await jump(third);await expect(page.locator('.header-title h1')).toHaveText(b.title);
    }finally{await page.evaluate(()=>window.resumeSourceNavigationFrames?.());}
    await expectPage(5);
    await page.getByRole('button',{name:'返回阅读',exact:true}).click();await expectPage(4);
    await expect.poll(async()=>Math.abs(await offset()-readyOffset)).toBeLessThan(.01);
    await forward.click();await expectPage(5);await expect(marker(third)).toBeVisible();
    // A modal or unsaved bookmark blocks a source URL without leaving the URL
    // pointing at a destination the visible reader refused.
    await page.getByRole('button',{name:'资料位置',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'资料位置',exact:true})).toBeVisible();
    await jump(first);
    assert.equal(new URL(page.url()).searchParams.get('capture'),third.captureId);
    await expect(page.getByRole('dialog',{name:'资料位置',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'关闭资料位置',exact:true}).click();await expectPage(5);
    await page.getByRole('button',{name:'展开书签',exact:true}).click();
    await page.getByRole('button',{name:'添加当前页书签',exact:true}).click();
    await page.getByRole('button',{name:/^重命名书签：.*PDF 第 5 页$/}).click();
    await page.getByRole('textbox',{name:'书签名称，PDF 第 5 页',exact:true}).fill('Retained synthetic bookmark draft');
    await expect(back).toBeDisabled();await jump(first);
    assert.equal(new URL(page.url()).searchParams.get('capture'),third.captureId);
    await expect(page.getByRole('textbox',{name:'书签名称，PDF 第 5 页',exact:true})).toHaveValue('Retained synthetic bookmark draft');
    await page.getByRole('button',{name:'取消重命名',exact:true}).click();
    await page.getByRole('button',{name:'关闭书签',exact:true}).click();await expectPage(5);
    // Invalid/stale source identities never fall back to another page or erase history.
    await jump({...second,page:4});await expect(page.getByRole('alert')).toContainText('不一致');await expectPage(5);await expect(marker(third)).toBeVisible();
    await jump({...second,pdfSha256:'0'.repeat(64)});await expect(page.getByRole('alert')).toContainText('身份已改变');await expectPage(5);
    assert.equal(new URL(page.url()).searchParams.get('capture'),third.captureId);
    const holdCapture=async()=>{
      let entered;const held=new Promise(resolve=>{entered=resolve;});const blocked=new Promise(resolve=>{release=resolve;});
      await page.route(`**/api/integrations/knowledge/capture/${first.captureId}`,async route=>{
        const response=await route.fetch();entered();await blocked;
        await route.fulfill({response}).catch(()=>{});
      });
      return held;
    };
    let held=holdCapture();await jump(first);await held;
    await page.getByRole('button',{name:'取消跳转',exact:true}).click();await expectPage(5);release();
    await expect(marker(third)).toBeVisible();assert.equal(new URL(page.url()).searchParams.get('capture'),third.captureId);
    await page.unroute(`**/api/integrations/knowledge/capture/${first.captureId}`);
    held=holdCapture();await jump(first);await held;await jump(second);await expectPage(3);await expect(marker(second)).toBeVisible();release();
    await page.unroute(`**/api/integrations/knowledge/capture/${first.captureId}`);
    await expect(marker(first)).toHaveCount(0);assert.equal(new URL(page.url()).searchParams.get('capture'),second.captureId);
    // Search resolves a current annotation identity, then history restores a capture.
    const expand=page.getByRole('button',{name:'展开文献栏',exact:true});if(await expand.count())await expand.click();
    await page.getByRole('textbox',{name:'全文搜索',exact:true}).fill('focused-citation-browser');
    await page.locator('.search-result').filter({hasText:'批注'}).click();await expectPage(4);
    await expect(page.locator(`[data-annotation="${annotation.id}"].focused`)).toBeVisible();
    await back.click();await expectPage(3);await expect(marker(second)).toBeVisible();
    await openReaderDisplay(page); await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('continuous');
    await closeReaderDisplay(page);
    await page.getByRole('combobox',{name:'阅读缩放',exact:true}).selectOption('1.5');
    await geometry(second,{x:.2,y:.25,width:.6,height:.3});
    await page.getByRole('button',{name:'关闭来源定位',exact:true}).click();await expect(marker(second)).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get('capture'),null);
    await page.getByRole('combobox',{name:'阅读缩放',exact:true}).selectOption('fit');await expect(marker(second)).toHaveCount(0);

    // A successful local deletion removes its focus identity from the current
    // URL and every history entry, without blocking refresh or back/forward.
    await openReaderDisplay(page); await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('paged');
    await closeReaderDisplay(page);
    const annotationTarget={documentId:a.id,page:4,pdfSha256:a.pdfSha256,annotationId:annotation.id};
    await jump(annotationTarget);await expectPage(4);
    await page.getByRole('button',{name:'下一页',exact:true}).click();await expectPage(5);
    await back.click();await expectPage(4);await expect(forward).toBeEnabled();
    const card=page.locator(`[data-annotation-id="${annotation.id}"]`),deleteUrl=`${base}/api/documents/${a.id}/annotations/${annotation.id}`;
    await page.route(deleteUrl,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic unconfirmed deletion'})}));
    await card.getByRole('button',{name:'删除批注',exact:true}).click();
    await card.getByRole('button',{name:'删除',exact:true}).click();
    await expect(card.getByRole('alert')).toContainText('删除结果未确认');
    assert.equal(new URL(page.url()).searchParams.get('annotation'),annotation.id);
    await expect(page.locator('.source-return-status')).toContainText('已定位来源批注');
    await page.unroute(deleteUrl);
    await card.getByRole('button',{name:'删除',exact:true}).click();await expect(card).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get('annotation'),null);
    await expect(page.locator('.source-return-status')).toHaveCount(0);
    await expect(forward).toBeEnabled();await forward.click();await expectPage(5);
    await back.click();await expectPage(4);
    await page.reload();await expectPage(4);
    assert.equal(new URL(page.url()).searchParams.get('annotation'),null);
    await jump(annotationTarget);await expect(page.getByRole('alert')).toContainText('来源批注已删除');await expectPage(4);
    assert.equal(new URL(page.url()).searchParams.get('annotation'),null,'External stale links still fail without restoring a deleted identity');

    // Actual wheel navigation replaces the current entry but must branch after
    // Back; unchanged scroll samples must not invalidate a usable Forward.
    for(const number of [1,3,5]){await pageInput.fill(String(number));await pageInput.press('Enter');await expectPage(number);}
    await back.click();await expectPage(3);await expect(forward).toBeEnabled();
    await openReaderDisplay(page); await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('continuous');
    await closeReaderDisplay(page);
    await expectPage(3);await expect(forward).toBeEnabled();
    const paper=await page.locator('.pdf-paper[data-page="3"]').boundingBox();
    await page.locator('.pdf-scroll').hover();await page.mouse.wheel(0,Math.ceil(paper.height+20));
    await expectPage(4);await expect(forward).toBeDisabled();
    const continuousOffset=await offset();
    await phase('continuous-history-return',continuousOffset);
    await back.click();await expectPage(1);
    await expect(page.locator('.pdf-paper[data-page="1"]')).toBeInViewport();
    await forward.click();await expectPage(4);
    await expect(page.locator('.pdf-paper[data-page="4"]')).toBeInViewport();
    await expect.poll(async()=>Math.abs(await offset()-continuousOffset)).toBeLessThan(.01);
    // A source detour on the same physical page restores the reading offset,
    // rather than leaving the PDF centered on the cited rectangle.
    await openReaderDisplay(page); await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('paged');
    await closeReaderDisplay(page);
    await page.getByRole('combobox',{name:'阅读缩放',exact:true}).selectOption('1.5');
    await pageInput.fill('2');await pageInput.press('Enter');await expectPage(2);
    await expect(page.locator('.reader-status')).toHaveCount(0);
    await page.locator('.pdf-scroll').evaluate(root=>{root.scrollTop=180;root.dispatchEvent(new Event('scroll'));});
    await expect.poll(offset).toBeGreaterThan(.05);const samePageOffset=await offset();
    await phase('same-page-blur-and-return',samePageOffset);
    await pageInput.press('Tab');
    await expect.poll(async()=>Math.abs(await offset()-samePageOffset)).toBeLessThan(.01);
    await pageInput.focus();
    await jump(first);await expect(marker(first)).toBeVisible();
    await page.getByRole('button',{name:'返回阅读',exact:true}).click();await expectPage(2);
    await expect(marker(first)).toHaveCount(0);
    await expect.poll(async()=>Math.abs(await offset()-samePageOffset)).toBeLessThan(.01);
    await forward.click();await expect(marker(first)).toBeVisible();
    assert.deepEqual(await readFile(join(vaultDir,'来源甲.pdf')),Buffer.concat([bookmarkedPdf(),Buffer.from('\n% 来源甲')]));
    assert.deepEqual(errors,[]);
    console.log('PASS: precise capture/annotation focus, repeat deduplication, cross-document history, branching, invalid identity rejection, cancelled and superseded jumps, zoom and dismissal');
    console.log('PASS: source return action and normalized same-page, cross-document and continuous-reading viewport restoration');
    console.log('PASS: a positioned ready page records a scroll before the next frame releases its navigation guard');
    console.log('PASS: unchanged page-field blur preserves reading anchors before same-page and cross-document source jumps');
    console.log('PASS: acknowledged annotation deletion clears focus/history/URL, failed deletion preserves them, refresh/stale-link guards and continuous-scroll history branching');
  } catch(error) {
    try {
      const trace=await page?.evaluate(()=>{window.sampleSourceViewport?.('failure');return window.sourceViewportTrace;});
      if(trace)console.error('SOURCE_VIEWPORT_DIAGNOSTIC',JSON.stringify(trace));
    } catch {/* Preserve the original assertion if the renderer is unavailable. */}
    throw error;
  } finally {
    release?.();await page?.close();
    server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
    await runtime?.close();await rm(root,{recursive:true,force:true});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let browser;
  try{browser=await chromium.launch(process.env.PAPERDESK_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERDESK_CHROMIUM_EXECUTABLE}:{});const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);await sourceNavigationWorkflow({context});}
  finally{await browser?.close();}
}
