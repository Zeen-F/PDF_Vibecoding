import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
function within(root, target) { const r=path.relative(root,target); return !r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r); }
function checked(root, target) { let cursor=target; while(!fs.existsSync(cursor))cursor=path.dirname(cursor); if(!within(root,fs.realpathSync(cursor)))throw new Error('导出位置指向知识库之外。');return target; }
function write(file, bytes) { const temp=file+'.'+randomUUID()+'.tmp'; try{fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});const fd=fs.openSync(temp,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);if(hash(fs.readFileSync(file))!==hash(bytes))throw new Error('导出读回校验失败。');}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);} }

export function registerKnowledgeExport({ app, vaultStore, documentOr404, HttpError, objectBody, stringValue, uuidValue, pageValue, rectanglesValue }) {
  app.post('/api/integrations/knowledge/export', (req,res) => {
    if(!vaultStore)throw new HttpError(409,'请先在纸间连接 Obsidian 知识库，再发送到知识工作台。');
    const body=objectBody(req.body,['requestId','documentId','page','rects','quote','comment','image']);
    const id=uuidValue(body.requestId,'导出请求'),documentId=uuidValue(body.documentId,'文献'),doc=documentOr404(documentId);
    const page=pageValue(body.page,doc.page_count),rects=rectanglesValue(body.rects);
    if(rects.length>100)throw new HttpError(400,'每次最多发送 100 个文字区域，请缩小选区。');
    const quote=stringValue(body.quote??'','引文',100000),comment=stringValue(body.comment??'','想法',20000);
    let image;
    if(body.image!==undefined){
      const encoded=stringValue(body.image,'图片',28*1024*1024).replace(/^data:image\/png;base64,/,'');image=Buffer.from(encoded,'base64');
      if(image.toString('base64')!==encoded||image.length>20*1024*1024||image.length<24||!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new HttpError(400,'选区图片必须是有效的 PNG，请重新框选。');
    }
    if(!image&&!quote.trim())throw new HttpError(400,'选区没有文字或原图，请回到 PDF 重新框选。');
    const requestHash=hash(JSON.stringify({documentId,page,rects,quote,comment,image:image?hash(image):null}));
    const exportRoot=checked(vaultStore.vaultDir,path.join(vaultStore.rootDir,'Exports'));
    fs.mkdirSync(exportRoot,{recursive:true});
    const folder=checked(vaultStore.vaultDir,path.join(exportRoot,id));fs.mkdirSync(folder,{recursive:true});
    const manifestFile=checked(vaultStore.vaultDir,path.join(folder,'manifest.json'));
    if(fs.existsSync(manifestFile)){const saved=JSON.parse(fs.readFileSync(manifestFile,'utf8'));if(saved.requestHash!==requestHash)throw new HttpError(409,'此请求标识已保存不同内容，请核对后重新发送。');return res.json({id,duplicate:true,relativePath:relative(vaultStore.vaultDir,folder)});}
    const intent=checked(vaultStore.vaultDir,path.join(folder,'.request.json'));
    if(fs.existsSync(intent)){if(JSON.parse(fs.readFileSync(intent,'utf8')).requestHash!==requestHash)throw new HttpError(409,'前次导出尚未完成，请保持原内容重试。');}else write(intent,JSON.stringify({requestHash}));
    const record=vaultStore.readDocument(documentId);
    // Verify the original PDF against its recorded identity; do not copy it into the bundle.
    vaultStore.readPdfSnapshot(documentId,doc.sha256);
    const manifest={schema:'paperdesk-capture/v1',id,createdAt:new Date().toISOString(),requestHash,source:{documentId,title:doc.title,pdfSha256:doc.sha256,pdfPath:relative(vaultStore.vaultDir,record.pdfPath),notePath:relative(vaultStore.vaultDir,vaultStore.notePath(documentId)),page,rects,quote},comment,...(image?{image:{file:'selection.png',sha256:hash(image),mime:'image/png'}}:{})};
    if(image)write(checked(vaultStore.vaultDir,path.join(folder,'selection.png')),image);
    // Consumers wait for this final, complete manifest and validate every attachment hash.
    write(manifestFile,JSON.stringify(manifest,null,2));
    res.status(201).json({id,duplicate:false,relativePath:relative(vaultStore.vaultDir,folder)});
  });
}
