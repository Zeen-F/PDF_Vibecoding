import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';

export async function vaultWorkflow({context,root,onPreview}) {
  const fixture=await mkdtemp(path.join(tmpdir(),'paperdesk-vault-browser-'));
  const vaultDir=path.join(fixture,'精读知识库'), dataDir=path.join(fixture,'cache');
  await mkdir(path.join(vaultDir,'.obsidian'),{recursive:true});
  const runtime=createApp({vaultDir,dataDir});await runtime.ready;
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let release;
  try {
    await page.goto(base);await page.waitForLoadState('networkidle');
    await page.getByRole('button',{name:'资料位置',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'资料位置',exact:true});
    await expect(dialog).toContainText('Obsidian 仓库');await expect(dialog).toContainText('精读知识库');
    await expect(dialog.getByRole('button',{name:'在 Obsidian 中打开笔记'})).toBeDisabled();
    await dialog.getByRole('button',{name:'关闭资料位置'}).click();
    const imported=page.waitForResponse(response=>response.url()===`${base}/api/documents`&&response.request().method()==='POST');
    await page.getByLabel('选择 PDF 文件').setInputFiles(path.join(root,'public/examples/reading-demo.pdf'));
    const importResponse=await imported;assert.equal(importResponse.status(),201);const doc=(await importResponse.json()).document;
    const editor=page.getByRole('textbox',{name:'笔记',exact:true});await expect(editor).toBeVisible();
    await expect(page.getByLabel('PDF 第 1 页',{exact:true})).toBeVisible();
    await editor.fill('Paperdesk 初始理解');await page.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到 Obsidian 仓库');
    const note=path.join(vaultDir,'Paperdesk','Notes',`${doc.id}.md`);
    await writeFile(note,(await readFile(note,'utf8')).replace('Paperdesk 初始理解','Obsidian 修改：先核对工作条件。'));
    await expect(editor).toHaveValue('Obsidian 修改：先核对工作条件。',{timeout:12000});
    console.log('PASS: vault PDF import, formal Markdown save and automatic external-note readback');
    let entered;
    const captured=new Promise(resolve=>{entered=resolve;});
    const held=new Promise(resolve=>{release=resolve;});
    await page.route(`${base}/api/documents/${doc.id}`,async route=>{
      if(route.request().method()==='PATCH'&&typeof route.request().postDataJSON()?.notesZh==='string'){
        entered();await held;
      }
      await route.continue();
    });
    await editor.fill('Paperdesk 同时编辑的完整草稿');await captured;
    await writeFile(note,(await readFile(note,'utf8')).replace('Obsidian 修改：先核对工作条件。','Obsidian 同时编辑的正式正文'));
    await expect.poll(async()=>(await(await fetch(`${base}/api/documents/${doc.id}`)).json()).document.notesZh).toBe('Obsidian 同时编辑的正式正文');
    await expect(editor).toHaveValue('Paperdesk 同时编辑的完整草稿');
    release();release=null;
    await expect(page.locator('.notes-conflict')).toBeVisible({timeout:12000});
    const conflicts=path.join(vaultDir,'Paperdesk','Notes','Conflicts');
    await expect.poll(async()=>{try{return(await readdir(conflicts)).length;}catch{return 0;}}).toBeGreaterThan(0);
    assert.ok((await readFile(note,'utf8')).includes('Obsidian 同时编辑的正式正文'));
    await expect(page.locator('.save-row [role="status"]')).toHaveText('版本冲突，草稿已保留');
    await page.getByRole('button',{name:'保留草稿并载入已保存笔记'}).click();
    await expect(editor).toHaveValue('Obsidian 同时编辑的正式正文');
    const archived=await readdir(conflicts);assert.ok((await Promise.all(archived.map(name=>readFile(path.join(conflicts,name),'utf8')))).some(text=>text.includes('Paperdesk 同时编辑的完整草稿')));
    await page.unroute(`${base}/api/documents/${doc.id}`);
    await page.getByRole('button',{name:'资料位置',exact:true}).click();
    await dialog.getByRole('button',{name:'重新读取仓库'}).click();await expect(dialog).toContainText('1 份文献');
    await expect(dialog.getByRole('button',{name:'在 Obsidian 中打开笔记'})).toBeEnabled();
    await onPreview?.(page,'vault-storage');
    await page.setViewportSize({width:900,height:800});await onPreview?.(page,'vault-storage-narrow');
    await dialog.getByRole('button',{name:'关闭资料位置'}).click();
    await page.reload();await expect(editor).toHaveValue('Obsidian 同时编辑的正式正文');
    assert.deepEqual(errors,[]);
    console.log('PASS: simultaneous external/in-flight saves preserve both files and editor draft; recovery, storage dialog, refresh and reopen');
  } finally {
    release?.();await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();await rm(fixture,{recursive:true,force:true});
  }
}
