import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.PORT||4317),url=`http://127.0.0.1:${port}`;
async function running(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(900)});const j=await r.json();if(!j.ok)return false;const home=await fetch(url,{signal:AbortSignal.timeout(900)});return (await home.text()).includes('纸间 Paperdesk');}catch{return false;}}
function open(){spawn('/usr/bin/open',[url],{stdio:'ignore'}).unref();}
if(await running()) {console.log(`纸间已经启动：${url}`);open();}
else {
  const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,stdio:'inherit',env:process.env});
  let done=false;child.on('exit',code=>{done=true;process.exitCode=code||0;});
  for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>child.kill(event));
  for(let i=0;i<40&&!done;i++){await new Promise(r=>setTimeout(r,250));if(await running()){console.log('浏览器已打开。保持此窗口运行；结束时按 Control+C。');open();break;}}
}
