import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
function within(root, target) { const r=path.relative(root,target); return !r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r); }
function checked(root, target) { let cursor=target; while(!fs.existsSync(cursor))cursor=path.dirname(cursor); if(!within(root,fs.realpathSync(cursor)))throw new Error('导出位置指向知识库之外。');return target; }
function write(file, bytes) { const temp=file+'.'+randomUUID()+'.tmp'; try{fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});const fd=fs.openSync(temp,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);if(hash(fs.readFileSync(file))!==hash(bytes))throw new Error('导出读回校验失败。');}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);} }

export function registerKnowledgeExport({ app, vaultStore, documentOr404, HttpError, objectBody, stringValue, uuidValue, pageValue, rectanglesValue }) {
  const requireVault = () => {
    if (!vaultStore) throw new HttpError(409, '请先在纸间连接 Obsidian 知识库，再发送到知识工作台。');
  };
  app.get('/api/integrations/knowledge/status', (_req, res) => {
    requireVault();
    res.json({ schema: 'paperdesk-knowledge/v1', vaultPath: vaultStore.vaultDir,
      subdir: relative(vaultStore.vaultDir, vaultStore.rootDir) });
  });
  app.get('/api/integrations/knowledge/source/:id', (req, res) => {
    requireVault();
    const id = uuidValue(req.params.id, '文献'), doc = documentOr404(id);
    const record = vaultStore.readDocument(id);
    vaultStore.readPdfSnapshot(id, doc.sha256);
    res.json({ documentId: id, pdfSha256: doc.sha256, pageCount: doc.page_count,
      pdfPath: relative(vaultStore.vaultDir, record.pdfPath),
      notePath: relative(vaultStore.vaultDir, vaultStore.notePath(id)) });
  });
  app.get('/api/integrations/knowledge/capture/:id', (req, res) => {
    requireVault();
    const id = uuidValue(req.params.id, '采集');
    const folder = checked(vaultStore.vaultDir, path.join(vaultStore.rootDir, 'Exports', id));
    const file = checked(vaultStore.vaultDir, path.join(folder, 'manifest.json'));
    if (!fs.existsSync(file)) throw new HttpError(404, '来源采集不存在或尚未同步完成，请保留工作台中的材料。');
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid manifest');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.schema !== 'paperdesk-capture/v1' || manifest.id !== id
        || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
        || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
        || typeof manifest.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.requestHash)) throw new Error('wrong capture identity');
      const documentId = uuidValue(manifest.source?.documentId, '文献'), doc = documentOr404(documentId);
      const page = pageValue(manifest.source.page, doc.page_count), rects = rectanglesValue(manifest.source.rects);
      if (rects.length > 100 || manifest.source.pdfSha256 !== doc.sha256) throw new Error('changed source');
      const quote = stringValue(manifest.source.quote, '引文', 100000), comment = stringValue(manifest.comment, '想法', 20000);
      let imageHash = null;
      if (manifest.image) {
        if (manifest.image.file !== 'selection.png' || manifest.image.mime !== 'image/png'
          || !/^[a-f0-9]{64}$/.test(manifest.image.sha256)) throw new Error('invalid image identity');
        const imageFile = checked(vaultStore.vaultDir, path.join(folder, 'selection.png'));
        const imageStat = fs.statSync(imageFile);
        if (!imageStat.isFile() || imageStat.size > 20 * 1024 * 1024 || imageStat.size < 24) throw new Error('invalid image');
        const image = fs.readFileSync(imageFile); imageHash = hash(image);
        if (imageHash !== manifest.image.sha256 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('changed image');
      }
      if (!imageHash && !quote.trim()) throw new Error('empty capture');
      if (hash(JSON.stringify({ documentId, page, rects, quote, comment, image: imageHash })) !== manifest.requestHash) throw new Error('changed capture');
      // A capture is useful only for the exact original PDF, never a replacement
      // with the same filename. No rectangles or paths are accepted from the URL.
      vaultStore.readPdfSnapshot(documentId, doc.sha256);
      res.json({ id, documentId, pdfSha256: doc.sha256, page, rects });
    } catch {
      throw new HttpError(409, '来源采集、附件或原 PDF 已改变或不完整，未跳转。请核对原包并等待同步完成。');
    }
  });
  app.post('/api/integrations/knowledge/export', (req,res) => {
    requireVault();
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
    if (fs.existsSync(manifestFile)) {
      const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (saved.requestHash !== requestHash) throw new HttpError(409, '此请求标识已保存不同内容，请核对后重新发送。');
      const savedHash = hash(JSON.stringify({ documentId: saved.source?.documentId, page: saved.source?.page,
        rects: saved.source?.rects, quote: saved.source?.quote, comment: saved.comment, image: saved.image?.sha256 || null }));
      if (saved.schema !== 'paperdesk-capture/v1' || saved.id !== id || savedHash !== requestHash)
        throw new HttpError(409, '已保存的交换清单发生变化，请核对原包；本次输入仍可重试。');
      if (image) {
        const imagePath = checked(vaultStore.vaultDir, path.join(folder, 'selection.png'));
        if (!fs.existsSync(imagePath) || hash(fs.readFileSync(imagePath)) !== hash(image))
          throw new HttpError(409, '已保存的原图缺失或发生变化，请等待同步完成或核对原包。');
      }
      return res.json({ id, duplicate: true, relativePath: relative(vaultStore.vaultDir, folder) });
    }
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
