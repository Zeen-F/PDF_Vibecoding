import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { sourceLinkSearch } from '../shared/source-navigation.mjs';

/** Original fixtures and an owned temporary vault only; never a personal library. */
export async function sourceNavigationWorkflow({context}) {
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
    await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('paged');
    await page.getByRole('combobox',{name:'页面布局',exact:true}).selectOption('1');
    await geometry(first,{x:.1,y:.68,width:.5,height:.2});await expect(back).toBeDisabled();
    // Same target repeats should refocus but must not create a second history entry.
    await jump(first);await expectPage(2);await geometry(first,{x:.1,y:.68,width:.5,height:.2});await expect(back).toBeDisabled();
    await page.getByRole('button',{name:'下一页',exact:true}).click();await expectPage(3);await expect(marker(first)).toHaveCount(0);
    await back.click();await expectPage(2);await expect(marker(first)).toBeVisible();
    await forward.click();await expectPage(3);await expect(marker(first)).toHaveCount(0);
    await back.click();await expectPage(2);
    const pageInput=page.getByRole('spinbutton',{name:'页码',exact:true});await pageInput.fill('4');await pageInput.press('Enter');await expectPage(4);await expect(forward).toBeDisabled();
    await jump(third);await expectPage(5);await expect(page.locator('.header-title h1')).toHaveText(b.title);
    await back.click();await expectPage(4);await expect(page.locator('.header-title h1')).toHaveText(a.title);
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
    await page.getByRole('combobox',{name:'翻页方式',exact:true}).selectOption('continuous');
    await page.getByRole('combobox',{name:'阅读缩放',exact:true}).selectOption('1.5');
    await geometry(second,{x:.2,y:.25,width:.6,height:.3});
    await page.getByRole('button',{name:'关闭来源定位',exact:true}).click();await expect(marker(second)).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get('capture'),null);
    await page.getByRole('combobox',{name:'阅读缩放',exact:true}).selectOption('fit');await expect(marker(second)).toHaveCount(0);
    assert.deepEqual(errors,[]);
    console.log('PASS: precise capture/annotation focus, repeat deduplication, cross-document history, branching, invalid identity rejection, cancelled and superseded jumps, zoom and dismissal');
  } finally {
    release?.();await page?.close();
    server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
    await runtime?.close();await rm(root,{recursive:true,force:true});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let browser;
  try{browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15000);await sourceNavigationWorkflow({context});}
  finally{await browser?.close();}
}
