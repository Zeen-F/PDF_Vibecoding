import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listVaultPdfs } from '../server/vault-pdfs.mjs';
import { directoryLinkType, fileSymlinkSkipReason } from './fixtures/filesystem-links.mjs';

function fixture(t) {
  const base=mkdtempSync(path.join(tmpdir(),'paperdesk-vault-pdfs-')),vaultDir=path.join(base,'vault');
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  mkdirSync(path.join(vaultDir,'.obsidian'),{recursive:true});
  const put=(relative,content='Inventory need not parse this PDF')=>{
    const file=path.join(vaultDir,...relative.split('/'));mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,content);return file;
  };
  return{base,vaultDir,put};
}
test('inventory retains nested Chinese/space/hash paths, skips hidden and linked surfaces and reads no PDF body',t=>{
  const h=fixture(t),linkedId='a-document-id';
  h.put('课程/期末资料/中文 # 阅读.PDF');h.put('root.pdf');h.put('.hidden.pdf');h.put('.obsidian/hidden.pdf');
  h.put('课程/.hidden/ignored.pdf');h.put('ordinary.md');
  const directory=path.join(h.base,'external-dir');mkdirSync(directory);writeFileSync(path.join(directory,'another.pdf'),'outside');symlinkSync(directory,path.join(h.vaultDir,'linked-dir'),directoryLinkType);
  const before=readdirSync(h.vaultDir,{recursive:true}).sort();
  const result=listVaultPdfs({vaultDir:h.vaultDir,documents:[{id:linkedId,path:'课程/期末资料/中文 # 阅读.PDF'}]});
  assert.equal(result.truncated,false);assert.equal(result.files.length,2);
  assert.deepEqual(result.files.map(file=>file.path).sort(),['root.pdf','课程/期末资料/中文 # 阅读.PDF']);
  assert.equal(result.files.find(file=>file.path==='root.pdf').documentId,null);
  const linked=result.files.find(file=>file.path.startsWith('课程/'));assert.equal(linked.documentId,linkedId);assert.equal(linked.name,'中文 # 阅读.PDF');
  assert.equal(linked.byteSize,Buffer.byteLength('Inventory need not parse this PDF'));
  assert.deepEqual(readdirSync(h.vaultDir,{recursive:true}).sort(),before);
});
test('inventory skips real file symlinks without opening their targets', { skip: fileSymlinkSkipReason() }, t=>{
  const h=fixture(t);h.put('root.pdf');
  const external=path.join(h.base,'external.pdf');writeFileSync(external,'outside');symlinkSync(external,path.join(h.vaultDir,'linked.pdf'),'file');
  const before=readdirSync(h.vaultDir).sort();
  assert.deepEqual(listVaultPdfs({vaultDir:h.vaultDir}).files.map(file=>file.path),['root.pdf']);
  assert.deepEqual(readdirSync(h.vaultDir).sort(),before);
});

test('inventory explicitly truncates only when another PDF exceeds the bounded result count',t=>{
  const h=fixture(t);for(let i=0;i<4;i++)h.put(`nested/${i}.pdf`);
  const truncated=listVaultPdfs({vaultDir:h.vaultDir,limit:3});assert.equal(truncated.files.length,3);assert.equal(truncated.truncated,true);
  const complete=listVaultPdfs({vaultDir:h.vaultDir,limit:4});assert.equal(complete.files.length,4);assert.equal(complete.truncated,false);
  assert.throws(()=>listVaultPdfs({vaultDir:h.vaultDir,limit:10001}),TypeError);
});
